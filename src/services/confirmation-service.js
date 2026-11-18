import { createHash } from 'node:crypto';
import { redact } from '../log.js';
import { OUTBOUND_LOGICAL_KEYS } from '../domain/order-meta.js';
import {
  ACTIVE_CONFIRMATION_STATUSES,
  DECISION,
  SEND_STATE,
  WOO_STATUS,
  WOO_SYNC_STATUS,
  WORKFLOW_STATE
} from '../domain/order-states.js';
import { interpolateTemplate, maskEmail, maskPhone, redactPhones, validatePhone } from '../utils/format.js';
import { DEFAULT_WOO_STATUSES } from '../utils/hd-status.js';
import { KeyedLock, outsideLocks } from '../utils/keyed-lock.js';
import { isOptOutMessage } from '../utils/opt-out.js';
import { parseDecisionReply } from '../utils/decision-reply.js';
import { isQuietHours } from '../utils/quiet-hours.js';
import { DEFAULT_CLAIM_SETTLE_MS, INSTANCE_ID } from './claim.js';
import { feedbackMethods } from './confirmation/feedback.js';
import { followupMethods } from './confirmation/followups.js';
import {
  CONFIRMATION_POLL_OPTIONS,
  extractFeedbackToken,
  extractWasenderInboundMessages,
  isConfirmationMessageKind,
  summarizeWasenderRequestStatus
} from './confirmation/inbound/wasender-parser.js';
import { optOutMethods } from './confirmation/opt-out.js';
import {
  buildDecisionMetaUpdate,
  buildLogicalSendMetaUpdate,
  buildTemplateValues,
  buildWorkflowMetaUpdate,
  compareOrdersByRecency,
  getDecisionMeta,
  getOrderDateValue,
  getFeedbackMeta,
  getOutboundReservationMeta,
  getWorkflowMeta,
  hasConfirmationWorkflowStarted,
  isConfirmationAlreadyStarted,
  isExpectedStatusForDecision,
  isFeedbackSelfTestOrder,
  mergeMetaUpdates,
  normalizeWooOrder
} from './confirmation/order-helpers.js';
import { ordersReadModelMethods } from './confirmation/orders-read-model.js';
import { reservedSendMethods } from './confirmation/outbound/reserved-send.js';
import { WasenderSendError } from './wasender-client.js';

const REPLY_RECOVERY_STATUSES = [...ACTIVE_CONFIRMATION_STATUSES];
const MAX_WOO_SYNC_ATTEMPTS = 6;
const REPLY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const REPLY_LOOKUP_MAX_PAGES = 10;
// A second "1" typed right after the first one is the same answer, not an answer for the customer's other open order.
const REPEAT_ANSWER_WINDOW_MS = 5 * 60 * 1000;
const INBOUND_MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
// The Wasender webhook is answered after at most this long; the work goes on in the background.
const DEFAULT_INBOUND_ACK_BUDGET_MS = 1000;
// The WooCommerce order webhook is answered after at most this long (WooCommerce waits about 5 s per delivery).
const DEFAULT_WOO_ACK_BUDGET_MS = 3000;

export class ConfirmationService {
  constructor({ store, wasenderClient, wooClient, mailService = null, wordpressClient = null, optOutKeywords = null, hdAutoSend = null, messages, wooStatuses = DEFAULT_WOO_STATUSES, durableState = null, notifyTeam = null, sleep = defaultSleep, claimSettleMs = DEFAULT_CLAIM_SETTLE_MS, instanceId = INSTANCE_ID, inboundAckBudgetMs = DEFAULT_INBOUND_ACK_BUDGET_MS, wooAckBudgetMs = DEFAULT_WOO_ACK_BUDGET_MS, logger = console }) {
    this.store = store;
    // Opt-outs are also saved in WooCommerce (services/durable-state.js): the local store is wiped on every restart.
    this.durableState = durableState;
    // One WhatsApp alert to the team phones (services/team-notifier.js); optional.
    this.notifyTeam = notifyTeam;
    this.sleep = sleep;
    // How long a send reservation waits before reading its claim back (services/claim.js); 0 = no wait.
    this.claimSettleMs = Number(claimSettleMs) || 0;
    this.instanceId = instanceId;
    // How long the Wasender webhook answer waits for the messages to be handled before answering "accepted".
    this.inboundAckBudgetMs = Math.max(0, Number(inboundAckBudgetMs) || 0);
    // The same for the WooCommerce order webhook.
    this.wooAckBudgetMs = Math.max(0, Number(wooAckBudgetMs) || 0);
    this.wasenderClient = wasenderClient;
    this.wooClient = wooClient;
    this.mailService = mailService;
    this.wordpressClient = wordpressClient;
    this.optOutKeywords = optOutKeywords;
    this.hdAutoSend = hdAutoSend;
    this.backgroundTasks = new Set();
    this.messages = messages;
    // The Woo status written when the customer confirms (on-hold until the order statuses plugin is installed).
    this.wooStatuses = { ...DEFAULT_WOO_STATUSES, ...(wooStatuses || {}) };
    // No customer message inside the quiet hours (see utils/quiet-hours.js). Unset in tests = never quiet.
    this.quietHours = messages?.quietHours?.enabled ? messages.quietHours : null;
    this.clock = () => new Date();
    this.logger = logger;
    // The per-order lock (utils/keyed-lock.js); the two maps keep their old names.
    this.orderLock = new KeyedLock({ prefix: 'order:', logger: () => this.logger });
    this.activeOrderLocks = this.orderLock.depths;
    this.orderMutexes = this.orderLock.mutexes;
    this.inFlightWooEvents = new Map();
    this.pendingInitialConfirmations = new Map();
    // orderId -> { dueAt, payload } for first-confirmation timers that have not fired yet.
    this.initialConfirmationDueAt = new Map();
    this.inFlightWasenderEvents = new Map();
    this.recentInboundMessageKeys = new Map();
  }

  // The local event log is a debug history: a disk problem there must never fail a webhook or a send.
  safeRecordEvent(source, eventKey, payload, status) {
    try {
      return this.store.recordEvent(source, eventKey, payload, status);
    } catch (error) {
      this.logger.warn(`[store] could not record ${source} event status=${status}: ${error.message}`);
      return null;
    }
  }

  withOrderLock(orderId, work) {
    return this.orderLock.run(orderId, work);
  }

  // Held back so the customer sees the thank-you page before the WhatsApp message lands.
  // If the process restarts during the wait, the hourly followup backfill sends it instead.
  scheduleInitialConfirmation(payload, orderId, delayMs) {
    const key = String(orderId);
    if (this.pendingInitialConfirmations.has(key)) {
      return { status: 202, body: { ok: true, duplicate: true, reason: 'confirmation_scheduled' } };
    }

    // Scheduled outside the lock this is called in, so the timer never carries the holder's token.
    const timer = outsideLocks(() => setTimeout(() => this.startDelayedInitialConfirmation(payload, key), delayMs));
    this.pendingInitialConfirmations.set(key, timer);
    this.initialConfirmationDueAt.set(key, { dueAt: Date.now() + delayMs, payload });
    this.logger.log(`[confirmation] initial send scheduled orderId=${key} delayMs=${delayMs}`);

    return { status: 202, body: { ok: true, scheduled: true, delayMs } };
  }

  // The timer fired (or a shutdown flush found it due): the send runs as a tracked background task, and the order stays
  // in pendingInitialConfirmations until it is done, so the hourly backfill never sends it as well.
  startDelayedInitialConfirmation(payload, key) {
    this.initialConfirmationDueAt.delete(key);
    return this.trackBackground(() => this.runDelayedInitialConfirmation(payload, key)
      .catch((error) => this.logger.error(error))
      .finally(() => this.pendingInitialConfirmations.delete(key)), `first confirmation ${key}`);
  }

  // For a shutdown (SIGTERM). A first message whose 30-second wait is over is started now (drain() then waits for it);
  // one that is not due yet is dropped here and logged: the order has no confirmation yet, so the hourly backfill
  // sends it (orders up to 72 hours old). Returns { started, leftToBackfill } (order ids).
  flushDueConfirmations({ now = Date.now() } = {}) {
    const started = [];
    const leftToBackfill = [];
    for (const [key, timer] of [...this.pendingInitialConfirmations.entries()]) {
      const pending = this.initialConfirmationDueAt.get(key);
      if (!pending) {
        continue; // already running
      }
      clearTimeout(timer);
      if (pending.dueAt <= now) {
        started.push(key);
        this.startDelayedInitialConfirmation(pending.payload, key);
        continue;
      }
      this.initialConfirmationDueAt.delete(key);
      this.pendingInitialConfirmations.delete(key);
      leftToBackfill.push(key);
      this.logger.warn(`[confirmation] shutdown: first WhatsApp message not sent yet orderId=${key} dueInMs=${pending.dueAt - now}; the hourly backfill sends it`);
    }
    return { started, leftToBackfill };
  }

  async runDelayedInitialConfirmation(payload, orderId) {
    await this.withOrderLock(orderId, async () => {
      let order = payload;
      try {
        order = (await this.wooClient.getOrder(orderId)) || payload;
      } catch (error) {
        this.logger.warn(`[confirmation] delayed send could not refresh orderId=${orderId} error=${error.message}`);
      }

      if (!ACTIVE_CONFIRMATION_STATUSES.includes(String(order?.status || ''))) {
        this.logger.log(`[confirmation] delayed send skipped orderId=${orderId} status=${String(order?.status || '')}`);
        return;
      }
      if (isConfirmationAlreadyStarted(getWorkflowMeta(order), this.store.getOrder(orderId))) {
        this.logger.log(`[confirmation] delayed send skipped orderId=${orderId} reason=already_started`);
        return;
      }

      const sendResult = await this.sendInitialConfirmation(order, {
        note: 'WhatsApp confirmation sent to customer.'
      });
      this.logger.log(
        `[confirmation] order processed orderId=${orderId} result=${sendResult.body?.reason || (sendResult.body?.ok ? 'confirmation_sent' : 'unknown')}`
      );
    });
  }

  // The WooCommerce order webhook. WooCommerce disables a webhook after 5 failed deliveries, so the answer never waits
  // longer than wooAckBudgetMs (3 s) for the order lock and the work: the delivery is deduped first, the work runs as
  // a tracked background task, and when it is not done in time the answer is 200 { accepted, pending } (the hourly
  // follow-ups pick up anything that still fails later, from WooCommerce itself).
  async processWooOrder(payload, eventKey) {
    if (this.inFlightWooEvents.has(eventKey)) {
      this.safeRecordEvent('woocommerce', eventKey, payload, 'duplicate_order');
      return { status: 200, body: { ok: true, duplicate: true, reason: 'event_in_flight' } };
    }
    this.inFlightWooEvents.set(eventKey, Date.now());

    const work = this.handleWooOrder(payload, eventKey);
    this.trackBackground(work, `woo order event ${eventKey}`);
    const settled = await settleWithin(work, this.wooAckBudgetMs);
    if (settled.done) {
      if (settled.error) {
        throw settled.error;
      }
      return settled.value;
    }
    this.logger.log(`[webhook][woocommerce] answered before the work finished eventId=${eventKey} orderId=${String(payload?.id ?? '')}`);
    return { status: 200, body: { ok: true, accepted: true, pending: true } };
  }

  async handleWooOrder(payload, eventKey) {
    try {
      const workflow = getWorkflowMeta(payload);
      const normalizedOrder = normalizeWooOrder(payload, this.messages);
      const existing = this.store.getOrder(normalizedOrder.orderId);
      const workflowStarted = hasConfirmationWorkflowStarted({ workflow, localOrder: existing });
      const isActiveStatus = ACTIVE_CONFIRMATION_STATUSES.includes(String(payload?.status || ''));

      const result = await this.withOrderLock(normalizedOrder.orderId, async () => {
        if (isFeedbackSelfTestOrder(payload)) {
          const feedbackMeta = getFeedbackMeta(payload);
          this.store.upsertOrder({
            ...existing,
            ...normalizedOrder,
            rawOrder: payload
          });
          this.logger.log(
            `[confirmation] skipped self-test confirmation send orderId=${normalizedOrder.orderId} testPhone=${maskPhone(feedbackMeta.testPhone)} token=${feedbackMeta.token || ''} runId=${feedbackMeta.testRunId || ''}`
          );
          return {
            status: 200,
            body: { ok: true, skipped: true, reason: 'feedback_self_test' }
          };
        }

        if (!isActiveStatus) {
          this.store.upsertOrder({
            ...existing,
            ...normalizedOrder,
            rawOrder: payload
          });
          const payloadDecision = getDecisionMeta(payload);
          const knownDecision = payloadDecision.decision || existing?.decision || '';
          // The service's own status change after the customer's answer (or the auto-send / delivery after it) comes
          // back as an order update: it is not a manual change.
          if (workflowStarted && knownDecision && isExpectedStatusForDecision(payload.status, knownDecision, this.wooStatuses)) {
            return { status: 200, body: { ok: true, skipped: true, reason: 'own_status_change' } };
          }
          if (workflowStarted && payloadDecision.manualOverride === 'yes' && payloadDecision.manualOverrideStatus === String(payload.status || '')) {
            return { status: 200, body: { ok: true, skipped: true, reason: 'manual_override' } };
          }
          if (workflowStarted) {
            await this.markManualOverride({
              order: {
                ...existing,
                ...normalizedOrder,
                rawOrder: payload
              },
              status: payload.status
            });
            return { status: 200, body: { ok: true, skipped: true, reason: 'manual_override' } };
          }
          return { status: 200, body: { ok: true, skipped: true, reason: 'inactive_status' } };
        }

        if (isConfirmationAlreadyStarted(workflow, this.store.getOrder(normalizedOrder.orderId))) {
          return { status: 200, body: { ok: true, duplicate: true, reason: 'duplicate_order' } };
        }

        const confirmationDelayMs = Number(this.messages.confirmationDelayMs) || 0;
        if (confirmationDelayMs > 0) {
          return this.scheduleInitialConfirmation(payload, normalizedOrder.orderId, confirmationDelayMs);
        }

        const sendResult = await this.sendInitialConfirmation(payload, {
          note: 'WhatsApp confirmation sent to customer.'
        });
        this.logger.log(
          `[confirmation] order processed orderId=${normalizedOrder.orderId} result=${sendResult.body?.reason || (sendResult.body?.ok ? 'confirmation_sent' : 'unknown')}`
        );
        return sendResult;
      });

      const eventStatus = result.body?.duplicate
        ? 'duplicate_order'
        : result.body?.reason === 'manual_override'
          ? 'manual_override'
        : result.body?.reason === 'own_status_change'
          ? 'own_status_change'
          : result.body?.reason === 'inactive_status'
            ? 'inactive_status'
        : result.body?.reason === 'feedback_self_test'
          ? 'feedback_self_test_skipped_confirmation'
          : (result.body?.reason || (result.body?.ok ? 'processed' : 'processing_failed'));
      this.safeRecordEvent('woocommerce', eventKey, payload, eventStatus);
      return result;
    } catch (error) {
      this.safeRecordEvent('woocommerce', eventKey, payload, 'processing_failed');
      throw error;
    } finally {
      this.inFlightWooEvents.delete(eventKey);
    }
  }

  // The Wasender webhook. The cheap part runs before the answer: parse, and drop messages already seen (in memory).
  // The rest (matching the order, the customer reply, the team alerts, the Woo writes, all inside the order lock) runs
  // as a tracked background task of the service (see drain()). The answer waits for it at most inboundAckBudgetMs:
  // when it finishes in time the answer carries the full summary as before, otherwise it says the messages were
  // accepted and are still being handled. A message seen again after a restart is still recognised inside the order
  // lock (the reply markers in the order meta are read again there).
  async processWasenderInbound(payload, eventKey) {
    if (this.inFlightWasenderEvents.has(eventKey)) {
      this.safeRecordEvent('wasender', eventKey, payload, 'duplicate_request');
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    this.inFlightWasenderEvents.set(eventKey, Date.now());

    let inboundMessages;
    try {
      inboundMessages = extractWasenderInboundMessages(payload, eventKey, this.logger);
    } catch (error) {
      this.inFlightWasenderEvents.delete(eventKey);
      this.safeRecordEvent('wasender', eventKey, payload, 'processing_failed');
      throw error;
    }
    if (!inboundMessages.length) {
      this.inFlightWasenderEvents.delete(eventKey);
      this.safeRecordEvent('wasender', eventKey, payload, 'ignored_non_message');
      return { status: 200, body: { ok: true, ignored: true, messageCount: 0 } };
    }

    // Dedupe now (not after routing): a second delivery of the same message arriving while this one is still being
    // handled is a duplicate, not a second reply.
    const messageStatuses = new Array(inboundMessages.length).fill('');
    const fresh = [];
    let duplicates = 0;
    this.pruneRecentInboundMessageKeys();
    inboundMessages.forEach((message, index) => {
      if (this.recentInboundMessageKeys.has(message.messageKey)) {
        duplicates += 1;
        messageStatuses[index] = 'duplicate_message';
        this.safeRecordEvent('wasender_message', message.messageKey, message.rawEnvelopeSnapshot, 'duplicate_message');
        return;
      }
      this.recentInboundMessageKeys.set(message.messageKey, Date.now());
      fresh.push({ message, index });
    });

    const work = this.handleInboundMessages(payload, eventKey, inboundMessages.length, fresh, messageStatuses, duplicates)
      .finally(() => this.inFlightWasenderEvents.delete(eventKey));
    this.trackBackground(work, `wasender event ${eventKey}`);

    const settled = await settleWithin(work, this.inboundAckBudgetMs);
    if (settled.done) {
      if (settled.error) {
        throw settled.error;
      }
      return settled.value;
    }
    this.logger.log(`[webhook][wasender] answered before the work finished eventId=${eventKey} messages=${inboundMessages.length} pending=${fresh.length}`);
    return {
      status: 200,
      body: { ok: true, accepted: true, pending: fresh.length, messageCount: inboundMessages.length, duplicates }
    };
  }

  async handleInboundMessages(payload, eventKey, messageCount, fresh, messageStatuses, duplicates) {
    try {
      const summary = {
        messageCount,
        processed: 0,
        ignored: 0,
        duplicates,
        failed: 0,
        feedback: 0,
        confirmation: 0,
        optOut: 0
      };

      for (const { message, index } of fresh) {
        let result;
        try {
          result = await this.routeInboundMessage(message);
        } catch (error) {
          this.logger.error(error);
          result = {
            ok: false,
            failed: true,
            ignored: false,
            duplicate: false,
            route: 'unknown',
            eventStatus: 'processing_failed',
            reason: error.message
          };
        }

        const eventStatus = result.eventStatus || 'processed';
        this.recentInboundMessageKeys.set(message.messageKey, Date.now());
        this.safeRecordEvent('wasender_message', message.messageKey, message.rawEnvelopeSnapshot, eventStatus);
        messageStatuses[index] = eventStatus;

        if (result.duplicate) {
          summary.duplicates += 1;
          continue;
        }

        if (result.failed) {
          summary.failed += 1;
          continue;
        }

        if (result.ignored) {
          summary.ignored += 1;
          continue;
        }

        summary.processed += 1;
        if (result.route === 'feedback') {
          summary.feedback += 1;
        }
        if (result.route === 'confirmation') {
          summary.confirmation += 1;
        }
        if (result.route === 'opt_out') {
          summary.optOut += 1;
        }
      }

      const requestStatus = summarizeWasenderRequestStatus(messageStatuses.filter(Boolean));
      this.safeRecordEvent('wasender', eventKey, payload, requestStatus);
      return {
        status: 200,
        body: {
          ok: true,
          ...summary
        }
      };
    } catch (error) {
      this.safeRecordEvent('wasender', eventKey, payload, 'processing_failed');
      throw error;
    }
  }

  // Keeps a promise on the list drain() waits for. Its failure is logged here (the caller may still await it).
  // Given a function, starts it outside every held lock (a task started inside a lock queues behind the holder).
  trackBackground(work, label = 'background task') {
    const promise = typeof work === 'function' ? outsideLocks(work) : work;
    const task = Promise.resolve(promise)
      .catch((error) => this.logger.warn(`[background] ${label} failed: ${error?.message || error}`))
      .finally(() => this.backgroundTasks.delete(task));
    this.backgroundTasks.add(task);
    return task;
  }

  async routeInboundMessage(message) {
    if (message.fromMe) {
      return {
        ok: true,
        ignored: true,
        duplicate: false,
        failed: false,
        route: 'ignored',
        eventStatus: 'ignored_non_message'
      };
    }

    if (message.senderPhone && this.optOutKeywords && isOptOutMessage(message.textBody, message.captionText, this.optOutKeywords)) {
      return this.handleOptOut(message);
    }

    const feedbackToken = extractFeedbackToken(message.textBody, message.captionText);
    if (feedbackToken) {
      const feedbackMatch = await this.matchFeedbackOrder(message, { token: feedbackToken.value, explicitToken: true });
      this.logger.log(
        `[feedback] route=token_match type=${feedbackToken.type} token=${feedbackToken.value} outcome=${feedbackMatch.kind} senderPhone=${maskPhone(message.senderPhone)} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }
    if (message.senderPhone && isConfirmationMessageKind(message.kind)) {
      const confirmationRoute = await this.routeConfirmationInboundMessage(message, { allowWooRecovery: false });
      if (confirmationRoute) {
        return confirmationRoute;
      }
    }

    const feedbackMatch = await this.matchFeedbackOrder(message);
    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'self_test_phone_local') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=self_test_phone_match source=local matchedOrderId=${feedbackMatch.orderId} senderPhone=${maskPhone(message.senderPhone)} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'self_test_phone_woo_recovery') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=self_test_phone_match source=woo_recovery matchedOrderId=${feedbackMatch.orderId} senderPhone=${maskPhone(message.senderPhone)} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'production_phone_local') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=production_phone_match source=local matchedOrderId=${feedbackMatch.orderId} senderPhone=${maskPhone(message.senderPhone)} senderRaw=${redactPhones(message.senderRaw)} recipient=${redactPhones(message.recipientRaw)} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'production_phone_woo_recovery') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=production_phone_match source=woo_recovery matchedOrderId=${feedbackMatch.orderId} senderPhone=${maskPhone(message.senderPhone)} senderRaw=${redactPhones(message.senderRaw)} recipient=${redactPhones(message.recipientRaw)} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (message.senderPhone && isConfirmationMessageKind(message.kind)) {
      const recoveredConfirmationRoute = await this.routeConfirmationInboundMessage(message, { allowWooRecovery: true });
      if (recoveredConfirmationRoute) {
        return recoveredConfirmationRoute;
      }
    }

    this.logger.log(
      `[feedback] route=feedback_unmatched senderPhone=${maskPhone(message.senderPhone)} senderRaw=${redactPhones(message.senderRaw)} recipient=${redactPhones(message.recipientRaw)} kind=${message.kind || 'unknown'} source=${feedbackMatch.source || 'unknown'} reason=${feedbackMatch.reason || 'no_match'} messageKey=${message.messageKey}`
    );
    return this.processFeedbackMatchResult(message, feedbackMatch);
  }

  async routeConfirmationInboundMessage(message, options = {}, replyContext = null) {
    if (!message.senderPhone || !isConfirmationMessageKind(message.kind)) {
      return null;
    }

    const resolvedReplyContext = replyContext || await this.resolveReplyContext(
      message.senderPhone,
      { allowWooRecovery: options.allowWooRecovery !== false }
    );
    const typedAnswer = message.kind === 'audio' ? '' : parseDecisionReply(message.textBody);
    const repeated = typedAnswer && resolvedReplyContext.pendingOrders.length > 0 && this.findRecentlyDecidedOrder(message.senderPhone, typedAnswer);
    if (repeated) {
      this.logger.log(`[confirmation] repeated answer ignored, the customer's other order was just decided orderId=${repeated.orderId} messageKey=${message.messageKey}`);
      this.appendInboundMessage({ message, orderId: repeated.orderId, storedKind: 'customer_reply' });
      return { ok: true, ignored: false, duplicate: true, failed: false, route: 'confirmation', eventStatus: 'duplicate_final_reply' };
    }
    if (resolvedReplyContext.pendingOrders.length > 1) {
      // The customer has several open orders and the answer does not say which: it applies to the newest one, and the team
      // is told once about the older ones (a double order is the usual cause) so nobody is left unanswered or surprised.
      const newestFirst = [...resolvedReplyContext.pendingOrders].sort(compareNewestFirst);
      this.logger.log(
        `[confirmation] several pending orders, reply goes to the newest senderPhone=${maskPhone(message.senderPhone)} orderId=${newestFirst[0].orderId} olderOrderIds=${newestFirst.slice(1).map((order) => order.orderId).join(',')} messageKey=${message.messageKey}`
      );
      // The newest order first; one that turns out to be closed (a stale cache entry) is skipped and the next one gets the answer.
      for (let index = 0; index < newestFirst.length; index += 1) {
        const target = newestFirst[index];
        const result = await this.processConfirmationInboundMessage(message, {
          ...resolvedReplyContext,
          pendingOrders: [target],
          pendingOrder: target
        });
        if (result?.reason === 'order_not_open' && index < newestFirst.length - 1) {
          continue;
        }
        if (result?.ok && !result.duplicate && !result.ignored) {
          await this.tellTeamAboutOlderOpenOrders({
            newest: target,
            older: newestFirst.filter((order) => order !== target && compareNewestFirst(order, target) > 0),
            message
          });
        }
        return result;
      }
    }

    if (!resolvedReplyContext.pendingOrder) {
      const inbound = {
        type: message.kind,
        text: message.textBody
      };
      this.appendInboundMessage({
        message,
        orderId: resolvedReplyContext.latestOrder?.orderId || null,
        storedKind: message.kind === 'audio' ? 'customer_audio_reply' : 'customer_reply'
      });

      if (resolvedReplyContext.latestOrder && isSameFinalDecision(resolvedReplyContext.latestOrder, inbound)) {
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'confirmation',
          eventStatus: 'duplicate_final_reply'
        };
      }

      return null;
    }

    this.logger.log(
      `[inbound] route=confirmation_candidate senderPhone=${maskPhone(message.senderPhone)} pendingOrderId=${resolvedReplyContext.pendingOrder.orderId} kind=${message.kind || 'unknown'} messageKey=${message.messageKey} source=${resolvedReplyContext.matchedViaWooFallback ? 'woo_pending' : 'local_pending'}`
    );
    return this.processConfirmationInboundMessage(message, resolvedReplyContext);
  }

  async processConfirmationInboundMessage(message, replyContext) {
    let pendingOrder = replyContext.pendingOrder;
    const latestOrder = replyContext.latestOrder;

    this.appendInboundMessage({
      message,
      orderId: latestOrder?.orderId || null,
      storedKind: message.kind === 'audio' ? 'customer_audio_reply' : 'customer_reply'
    });

    const result = await this.withOrderLock(pendingOrder.orderId, async () => {
      // The order meta is the record that survives a restart: read it again inside the lock, so a reply that was
      // already handled (same message key, decision already written) is recognised even with an empty local cache.
      if (typeof this.wooClient.getOrder === 'function') {
        try {
          const fresh = await this.wooClient.getOrder(pendingOrder.orderId);
          if (fresh && typeof fresh === 'object') {
            pendingOrder = { ...pendingOrder, rawOrder: fresh };
          }
        } catch (error) {
          this.logger.warn(`[confirmation] could not re-read orderId=${pendingOrder.orderId} before the reply: ${error.message}`);
        }
      }
      const reply = message.kind === 'audio' ? '' : parseDecisionReply(message.textBody);
      const decisionMeta = getDecisionMeta(pendingOrder.rawOrder || {});
      if (decisionMeta.lastConfirmationMessageKey && decisionMeta.lastConfirmationMessageKey === message.messageKey) {
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'confirmation',
          eventStatus: 'duplicate_confirmation_message'
        };
      }
      const lastConfirmationMessageKey = pendingOrder.lastConfirmationMessageKey || decisionMeta.lastConfirmationMessageKey || '';
      const currentInvalidReplyCount = Number(
        pendingOrder.invalidReplyCount
        ?? decisionMeta.invalidReplyCount
        ?? 0
      );
      const currentManualFollowupRequired = pendingOrder.manualFollowupRequired === true
        || decisionMeta.manualFollowupRequired === 'yes';

      if (lastConfirmationMessageKey && lastConfirmationMessageKey === message.messageKey) {
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'confirmation',
          eventStatus: 'duplicate_confirmation_message'
        };
      }

      // The record may have changed since the webhook arrived (the team confirmed, cancelled or shipped it by hand, or the
      // desktop app did): a late reply must not flip it back or answer a closed order.
      if (pendingOrder.rawOrder?.id) {
        const closedStatus = ['completed', 'cancelled', 'refunded', 'failed', 'trash'].includes(String(pendingOrder.rawOrder.status || ''));
        const freshWorkflow = getWorkflowMeta(pendingOrder.rawOrder);
        const sameDecisionAgain = (reply === '1' && decisionMeta.decision === DECISION.confirmed)
          || (reply === '2' && decisionMeta.decision === DECISION.cancelled);
        // An empty workflow state is still open: the confirmation went out but its meta write failed, and the customer's answer must count.
        const settledState = [WORKFLOW_STATE.confirmed, WORKFLOW_STATE.cancelled, WORKFLOW_STATE.manual].includes(freshWorkflow.state);
        const changedByHand = decisionMeta.manualOverride === 'yes' || (settledState && !sameDecisionAgain);
        if ((closedStatus && !sameDecisionAgain) || changedByHand) {
          this.logger.log(`[confirmation] reply ignored, the order is no longer open orderId=${pendingOrder.orderId} status=${pendingOrder.rawOrder.status}`);
          return {
            ok: false,
            ignored: true,
            duplicate: false,
            failed: false,
            route: 'confirmation',
            eventStatus: 'order_not_open',
            reason: 'order_not_open'
          };
        }
      }

      if (reply !== '1' && reply !== '2') {
        if (currentManualFollowupRequired) {
          this.store.upsertOrder({
            ...pendingOrder,
            invalidReplyCount: currentInvalidReplyCount,
            manualFollowupRequired: true,
            confirmationState: 'pending_confirmation',
            lastConfirmationMessageKey: message.messageKey
          });
          return {
            ok: false,
            ignored: true,
            duplicate: false,
            failed: false,
            route: 'confirmation',
            eventStatus: 'manual_followup_required',
            reason: 'manual_followup_required'
          };
        }

        if (this.isQuietNow()) {
          // The "please answer 1 or 2" message cannot go out now, so this reply is not counted against the customer.
          this.logger.log(`[quiet-hours] unclear reply not counted orderId=${pendingOrder.orderId}`);
          return {
            ok: false,
            ignored: true,
            duplicate: false,
            failed: false,
            route: 'confirmation',
            eventStatus: 'invalid_reply',
            reason: 'invalid_reply_quiet_hours'
          };
        }

        const nextInvalidReplyCount = Math.min(currentInvalidReplyCount + 1, 2);
        const nextManualFollowupRequired = nextInvalidReplyCount >= 2;
        let conversationOrder = pendingOrder.rawOrder || {};

        try {
          const updatedConversationOrder = await this.persistConversationState({
            orderPayload: pendingOrder.rawOrder || {},
            orderId: pendingOrder.orderId,
            invalidReplyCount: nextInvalidReplyCount,
            manualFollowupRequired: nextManualFollowupRequired,
            lastConfirmationMessageKey: message.messageKey
          });
          conversationOrder = updatedConversationOrder || conversationOrder;
        } catch (error) {
          this.logger.warn(`Unable to persist invalid reply state for order ${pendingOrder.orderId}: ${error.message}`);
        }

        this.store.upsertOrder({
          ...pendingOrder,
          rawOrder: conversationOrder,
          invalidReplyCount: nextInvalidReplyCount,
          manualFollowupRequired: nextManualFollowupRequired,
          confirmationState: 'pending_confirmation',
          lastConfirmationMessageKey: message.messageKey
        });

        if (nextInvalidReplyCount === 1) {
          await this.safeSendTrackedMessage({
            phone: pendingOrder.phone,
            orderId: pendingOrder.orderId,
            kind: 'clarification',
            message: this.messages.invalidReply
          });
        } else if (nextManualFollowupRequired) {
          this.logger.warn(`[confirmation] manual follow-up required after repeated invalid replies orderId=${pendingOrder.orderId}`);
        }

        return {
          ok: false,
          ignored: true,
          duplicate: false,
          failed: false,
          route: 'confirmation',
          eventStatus: nextManualFollowupRequired ? 'manual_followup_required' : 'invalid_reply',
          reason: nextManualFollowupRequired ? 'manual_followup_required' : 'invalid_reply'
        };
      }

      const nextState = reply === '1' ? DECISION.confirmed : DECISION.cancelled;
      const nextWooStatus = reply === '1' ? this.wooStatuses.confirmed : WOO_STATUS.cancelled;
      const note = reply === '1'
        ? 'Customer confirmed order via WhatsApp.'
        : 'Customer cancelled order via WhatsApp.';
      const followUpMessage = reply === '1'
        ? this.messages.confirmedReply
        : this.messages.cancelledReply;
      const nowIso = new Date().toISOString();
      const existingDecision = pendingOrder.decision || decisionMeta.decision;
      const customerReplySent = pendingOrder.customerReplySent || decisionMeta.customerReplySent;
      const internalNotifiedConfirmed = pendingOrder.internalNotifiedConfirmed || decisionMeta.internalNotifiedConfirmed;
      const internalNotifiedCancelled = pendingOrder.internalNotifiedCancelled || decisionMeta.internalNotifiedCancelled;

      if (existingDecision === nextState) {
        const reconciliation = await this.reconcileWooDecision({
          order: {
            ...pendingOrder,
            rawOrder: pendingOrder.rawOrder || {}
          },
          targetState: nextState,
          targetWooStatus: nextWooStatus,
          note,
          nowIso
        });
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'confirmation',
          eventStatus: reconciliation.success ? 'duplicate_final_reply' : reconciliation.syncStatus
        };
      }

      let nextOrderState = this.store.upsertOrder({
        ...pendingOrder,
        confirmationState: nextState,
        finalReply: reply,
        decision: nextState,
        decisionAt: nowIso,
        wooSyncStatus: WOO_SYNC_STATUS.pendingRetry,
        wooSyncAttempts: Number(pendingOrder.wooSyncAttempts || decisionMeta.wooSyncAttempts || 0),
        lastSyncError: '',
        customerReplySent: customerReplySent || 'no',
        invalidReplyCount: currentInvalidReplyCount,
        manualFollowupRequired: false,
        lastConfirmationMessageKey: message.messageKey
      });

      try {
        const decisionOrder = await this.persistWorkflowAndDecisionMeta({
          orderPayload: pendingOrder.rawOrder || {},
          orderId: pendingOrder.orderId,
          workflowValues: {
            state: nextState,
            cancelledAt: nextState === DECISION.cancelled ? nowIso : ''
          },
          decisionValues: {
            decision: nextState,
            decisionAt: nowIso,
            wooSyncStatus: WOO_SYNC_STATUS.pendingRetry,
            wooSyncAttempts: nextOrderState.wooSyncAttempts || 0,
            lastSyncError: '',
            customerReplySent: customerReplySent || 'no',
            invalidReplyCount: currentInvalidReplyCount,
            manualFollowupRequired: 'no',
            lastConfirmationMessageKey: message.messageKey
          }
        });
        nextOrderState = this.store.upsertOrder({
          ...nextOrderState,
          rawOrder: decisionOrder || nextOrderState.rawOrder
        });
      } catch (error) {
        this.logger.warn(`Unable to persist decision meta for order ${pendingOrder.orderId}: ${error.message}`);
      }

      if ((nextOrderState.customerReplySent || 'no') !== 'yes') {
        nextOrderState = await this.sendCustomerDecisionReply({
          order: nextOrderState,
          decisionOrderPayload: nextOrderState.rawOrder || pendingOrder.rawOrder || {},
          phone: pendingOrder.phone,
          logicalKey: reply === '1'
            ? OUTBOUND_LOGICAL_KEYS.confirmationSuccess
            : OUTBOUND_LOGICAL_KEYS.cancellationSuccess,
          nextState,
          nowIso,
          currentInvalidReplyCount,
          message: followUpMessage
        });
      }

      nextOrderState = await this.sendInternalDecisionNotifications({
        order: nextOrderState,
        decision: nextState,
        alreadyNotified: nextState === DECISION.confirmed
          ? internalNotifiedConfirmed === 'yes' || nextOrderState.internalNotifiedConfirmed === 'yes'
          : internalNotifiedCancelled === 'yes' || nextOrderState.internalNotifiedCancelled === 'yes'
      });

      const reconciliation = await this.reconcileWooDecision({
        order: nextOrderState,
        targetState: nextState,
        targetWooStatus: nextWooStatus,
        note,
        nowIso
      });
      if (nextState === DECISION.confirmed && reconciliation.success) {
        this.scheduleHdAutoSend(nextOrderState);
      }
      return {
        ok: true,
        ignored: false,
        duplicate: false,
        failed: false,
        route: 'confirmation',
        eventStatus: replyContext.matchedViaWooFallback
          ? 'matched_via_woo_fallback'
          : reconciliation.success
            ? nextState
            : reconciliation.syncStatus
      };
    });

    return result;
  }

  appendInboundMessage({ message, orderId, storedKind }) {
    this.store.appendMessage({
      source: 'inbound',
      orderId: orderId || null,
      phone: message.senderPhone || message.senderRaw || '',
      kind: storedKind,
      payload: message.rawEnvelopeSnapshot,
      text: message.textBody || '',
      caption: message.captionText || '',
      mimeType: message.mimeType || '',
      mediaUrl: message.mediaRef || '',
      providerMessageId: message.providerMessageId || '',
      timestamp: message.timestamp || '',
      messageType: message.kind || 'unknown'
    });
  }

  pruneRecentInboundMessageKeys() {
    const cutoff = Date.now() - INBOUND_MESSAGE_DEDUPE_TTL_MS;
    for (const [messageKey, timestamp] of this.recentInboundMessageKeys.entries()) {
      if (timestamp < cutoff) {
        this.recentInboundMessageKeys.delete(messageKey);
      }
    }
  }

  async persistWorkflowAndDecisionMeta({ orderPayload, orderId, workflowValues = {}, decisionValues = {} }) {
    return this.wooClient.updateOrderMeta(
      orderId,
      mergeMetaUpdates(
        buildWorkflowMetaUpdate(orderPayload, workflowValues),
        buildDecisionMetaUpdate(orderPayload, decisionValues)
      )
    );
  }

  // One customer message per delivery stage ("shipped", "arriving"), at most once per order, never in quiet hours.
  // Returns { sent, reason }. The Woo order fields are the "already sent" record.
  async sendHdStageMessage(orderPayload, stage, trackingNumber = '', now = new Date()) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const shipped = stage === 'shipped';
    const template = shipped ? this.messages.shippedMessage : this.messages.outForDeliveryMessage;
    if (!template || !normalizedOrder.phone) {
      return { sent: false, reason: 'no_template_or_phone' };
    }
    if (this.store?.isPhoneOptedOut?.(normalizedOrder.phone) || this.durableState?.isOptedOut?.(normalizedOrder.phone)) {
      return { sent: false, reason: 'opted_out' };
    }
    const logicalKey = shipped ? OUTBOUND_LOGICAL_KEYS.hdShipped : OUTBOUND_LOGICAL_KEYS.hdArriving;
    if (getOutboundReservationMeta(orderPayload, logicalKey).state === SEND_STATE.failed) {
      return { sent: false, reason: 'unreachable' };
    }
    let outcome;
    try {
      outcome = await this.sendLogicalMessageWithWooReservation({
        orderPayload,
        orderId: normalizedOrder.orderId,
        phone: normalizedOrder.phone,
        logicalKey,
        kind: shipped ? 'hd_shipped' : 'hd_arriving',
        message: interpolateTemplate(template, { ...buildTemplateValues(normalizedOrder), trackingNumber }),
        now
      });
    } catch (error) {
      if (!isWhatsAppContactabilityFailure(error)) {
        throw error;
      }
      // The number is not on WhatsApp: remember it, so the hourly task does not try again for two weeks.
      try {
        await this.wooClient.updateOrderMeta(
          normalizedOrder.orderId,
          buildLogicalSendMetaUpdate(orderPayload, logicalKey, { state: SEND_STATE.failed, reservedAt: now.toISOString() })
        );
      } catch (metaError) {
        this.logger.warn(`[hd-status] could not record the unreachable number orderId=${normalizedOrder.orderId}: ${metaError.message}`);
      }
      return { sent: false, reason: 'unreachable' };
    }
    if (outcome.deferred) {
      return { sent: false, reason: 'quiet_hours' };
    }
    if (outcome.duplicate || outcome.ambiguous) {
      return { sent: false, reason: outcome.ambiguous ? 'ambiguous' : 'already_sent' };
    }
    return { sent: outcome.ok === true, reason: '' };
  }

  // Sends the customer's "confirmed" / "cancelled" reply when it was held back (quiet hours). At most 48 hours after the decision.
  // Only a reply that the quiet hours held back (its reservation state is "deferred") is sent here. Auto-cancelled and
  // invalid-phone orders also have customerReplySent=no, but they are never marked deferred, so they are never messaged.
  async sendDeferredDecisionReply({ order, nextOrderState, decisionMeta, effectiveDecision, now }) {
    const decidedAt = decisionMeta.decisionAt || nextOrderState.decisionAt || '';
    const decidedMs = Date.parse(decidedAt);
    const confirmed = effectiveDecision === DECISION.confirmed;
    const logicalKey = confirmed ? OUTBOUND_LOGICAL_KEYS.confirmationSuccess : OUTBOUND_LOGICAL_KEYS.cancellationSuccess;
    if ((decisionMeta.customerReplySent || nextOrderState.customerReplySent || '') === 'yes'
      || getOutboundReservationMeta(order, logicalKey).state !== SEND_STATE.deferred
      || this.isQuietNow()
      || Number.isNaN(decidedMs)
      || now.getTime() - decidedMs > 48 * 60 * 60 * 1000
      || !nextOrderState.phone) {
      return false;
    }
    const updated = await this.sendCustomerDecisionReply({
      order: nextOrderState,
      decisionOrderPayload: order,
      phone: nextOrderState.phone,
      logicalKey,
      nextState: effectiveDecision,
      nowIso: decidedAt,
      reservationNow: now,
      currentInvalidReplyCount: decisionMeta.invalidReplyCount || 0,
      message: confirmed ? this.messages.confirmedReply : this.messages.cancelledReply
    });
    return (updated?.customerReplySent || '') === 'yes';
  }

  async sendCustomerDecisionReply({ order, decisionOrderPayload, phone, logicalKey, nextState, nowIso, currentInvalidReplyCount, message, reservationNow = null }) {
    // Quiet hours hold the reply back: remember that, so the hourly task sends exactly this reply later.
    if (this.isQuietNow()) {
      try {
        await this.wooClient.updateOrderMeta(
          order.orderId,
          buildLogicalSendMetaUpdate(decisionOrderPayload, logicalKey, { state: SEND_STATE.deferred, reservedAt: nowIso })
        );
      } catch (error) {
        this.logger.warn(`[quiet-hours] could not mark the held reply orderId=${order.orderId}: ${error.message}`);
      }
    }
    const sendOutcome = await this.sendLogicalMessageWithWooReservation({
      orderPayload: decisionOrderPayload,
      orderId: order.orderId,
      phone,
      logicalKey,
      kind: logicalKey === OUTBOUND_LOGICAL_KEYS.confirmationSuccess ? 'confirmation_success' : 'cancellation_success',
      message,
      now: reservationNow || new Date(nowIso),
      persistAfterSend: async ({ providerMessageId, reservedAt, reservationOrder }) => {
        const updatedOrder = await this.persistWorkflowAndDecisionMeta({
          orderPayload: reservationOrder || decisionOrderPayload,
          orderId: order.orderId,
          workflowValues: {
            state: nextState,
            cancelledAt: nextState === DECISION.cancelled ? nowIso : ''
          },
          decisionValues: {
            decision: nextState,
            decisionAt: nowIso,
            customerReplySent: 'yes',
            wooSyncStatus: order.wooSyncStatus || WOO_SYNC_STATUS.pendingRetry,
            wooSyncAttempts: order.wooSyncAttempts || 0,
            lastSyncError: order.lastSyncError || '',
            invalidReplyCount: currentInvalidReplyCount,
            manualFollowupRequired: 'no',
            lastConfirmationMessageKey: order.lastConfirmationMessageKey || ''
          }
        });
        const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
          order.orderId,
          buildLogicalSendMetaUpdate(updatedOrder || reservationOrder || decisionOrderPayload, logicalKey, {
            state: SEND_STATE.sent,
            reservedAt,
            messageId: providerMessageId
          })
        );
        return metaUpdatedOrder || updatedOrder;
      }
    });

    if (sendOutcome.persisted) {
      return this.store.upsertOrder({
        ...order,
        rawOrder: sendOutcome.persistResult || order.rawOrder,
        customerReplySent: 'yes'
      });
    }

    return this.store.upsertOrder({
      ...order,
      rawOrder: decisionOrderPayload,
      customerReplySent: order.customerReplySent || 'no',
      lastError: sendOutcome.ambiguous ? 'ambiguous_send_state' : (order.lastError || '')
    });
  }

  // The poll only adds a tap-to-answer option; the "1"/"2" text reply keeps working if it fails.
  async sendConfirmationPoll(normalizedOrder) {
    if (!this.messages.confirmationPollEnabled) {
      return;
    }

    try {
      const result = await this.wasenderClient.sendPoll({
        to: normalizedOrder.phone,
        question: this.messages.confirmationPollQuestion,
        options: CONFIRMATION_POLL_OPTIONS
      });
      this.store.appendMessage({
        source: 'outbound',
        orderId: normalizedOrder.orderId,
        phone: normalizedOrder.phone,
        kind: 'confirmation_poll',
        payload: result,
        text: this.messages.confirmationPollQuestion
      });
    } catch (error) {
      this.logger.warn(`[confirmation] poll send failed orderId=${normalizedOrder.orderId} message=${error.message}`);
    }
  }

  async persistInitialConfirmationMeta({ orderPayload, normalizedOrder, acceptedAt, providerMessageId, reservedAt }) {
    const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
      normalizedOrder.orderId,
      mergeMetaUpdates(
        buildWorkflowMetaUpdate(orderPayload, {
          state: WORKFLOW_STATE.pending,
          confirmationSentAt: acceptedAt,
          reminderCount: 0,
          lastReminderAt: '',
          cancelledAt: '',
          confirmationMessageId: providerMessageId || ''
        }),
        buildDecisionMetaUpdate(orderPayload, {
          decision: '',
          decisionAt: '',
          wooSyncStatus: '',
          wooSyncAttempts: 0,
          lastSyncError: '',
          customerReplySent: 'no',
          internalNotifiedConfirmed: 'no',
          internalNotifiedCancelled: 'no',
          invalidReplyCount: 0,
          manualFollowupRequired: 'no',
          lastConfirmationMessageKey: ''
        }),
        buildLogicalSendMetaUpdate(orderPayload, OUTBOUND_LOGICAL_KEYS.confirmationRequest, {
          state: SEND_STATE.sent,
          reservedAt,
          sentAt: acceptedAt,
          messageId: providerMessageId || ''
        })
      )
    );

    const persistedOrder = metaUpdatedOrder || orderPayload;
    this.store.upsertOrder({
      ...normalizedOrder,
      rawOrder: persistedOrder,
      confirmationState: 'pending_confirmation',
      confirmationSentAt: acceptedAt,
      invalidReplyCount: 0,
      manualFollowupRequired: false,
      wasenderMessageId: providerMessageId || ''
    });

    return persistedOrder;
  }

  async persistConversationState({ orderPayload, orderId, invalidReplyCount, manualFollowupRequired, lastConfirmationMessageKey }) {
    return this.persistWorkflowAndDecisionMeta({
      orderPayload,
      orderId,
      decisionValues: {
        invalidReplyCount,
        manualFollowupRequired: manualFollowupRequired ? 'yes' : 'no',
        lastConfirmationMessageKey
      }
    });
  }

  // An order of this phone that the customer decided in the last few minutes with the same answer, or null.
  findRecentlyDecidedOrder(phone, answer) {
    const decision = answer === '1' ? DECISION.confirmed : DECISION.cancelled;
    const now = Date.now();
    return this.store.listOrders().find((order) => order.phone === phone
      && order.decision === decision
      && now - Date.parse(order.decisionAt || '') < REPEAT_ANSWER_WINDOW_MS) || null;
  }

  async tellTeamAboutOlderOpenOrders({ newest, older, message }) {
    if (typeof this.notifyTeam !== 'function' || !older.length) {
      return;
    }
    const answer = parseDecisionReply(message.textBody) === '2' ? 'cancelled' : 'confirmed';
    const list = older.map((order) => `#${order.orderId}`).join(', ');
    try {
      await this.notifyTeam(
        `Same customer, ${older.length + 1} open orders. Their answer was applied to the newest, #${newest.orderId} (${answer}). `
        + `Still waiting: ${list}. Check if ${older.length > 1 ? 'they are duplicates' : 'it is a duplicate'} and cancel by hand if so.`
      );
    } catch (error) {
      this.logger.warn(`[confirmation] could not tell the team about older open orders orderId=${newest.orderId}: ${error.message}`);
    }
  }

  async resolveReplyContext(phone, { allowWooRecovery = true } = {}) {
    const localPendingOrders = this.store.listPendingOrdersByPhone(phone).sort(compareOrdersByRecency);
    const localLatestOrder = localPendingOrders[0] || this.store.findLatestOrderByPhone(phone);

    // The local cache is a file that starts empty after every restart, so it can know only the newest order of a customer
    // while an older one is still waiting in WooCommerce. WooCommerce is the record: both lists are merged, so the answer
    // is never given to the wrong order and a double order is always seen as two.
    let wooPendingOrders = [];
    // With nothing in the cache the first routing pass skips WooCommerce (allowWooRecovery false) and the feedback matching runs
    // before the recovering pass; with a cached order WooCommerce is always checked for older ones.
    if (allowWooRecovery || localPendingOrders.length > 0) {
      try {
        wooPendingOrders = await this.findPendingWooOrdersByPhone(phone);
      } catch (error) {
        this.logger.warn(`[confirmation] could not read the open orders of a customer from WooCommerce: ${error.message}`);
      }
    }
    const knownIds = new Set(localPendingOrders.map((order) => String(order.orderId)));
    const addedFromWoo = wooPendingOrders
      .filter((wooOrder) => !knownIds.has(String(wooOrder.id)))
      .map((wooOrder) => this.store.upsertOrder({
        ...normalizeWooOrder(wooOrder, this.messages),
        rawOrder: wooOrder,
        confirmationState: 'pending_confirmation',
        invalidReplyCount: getDecisionMeta(wooOrder).invalidReplyCount,
        manualFollowupRequired: getDecisionMeta(wooOrder).manualFollowupRequired === 'yes',
        lastConfirmationMessageKey: getDecisionMeta(wooOrder).lastConfirmationMessageKey || ''
      }));
    const pendingOrders = [...localPendingOrders, ...addedFromWoo].sort(compareNewestFirst);

    if (!pendingOrders.length) {
      return {
        pendingOrders: [],
        pendingOrder: null,
        latestOrder: localLatestOrder,
        matchedViaWooFallback: false
      };
    }
    return {
      pendingOrders,
      pendingOrder: pendingOrders[0],
      latestOrder: localPendingOrders[0] || pendingOrders[0],
      matchedViaWooFallback: localPendingOrders.length === 0
    };
  }

  async sendInitialConfirmation(orderPayload, { note, now = new Date() } = {}) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const phoneValidation = validatePhone(orderPayload?.billing?.phone || orderPayload?.shipping?.phone);
    if (phoneValidation.reason === 'missing_phone') {
      this.store.upsertOrder({
        ...normalizedOrder,
        confirmationState: 'failed_missing_phone',
        lastError: 'Missing or invalid phone number'
      });
      return { status: 202, body: { ok: false, reason: 'missing_phone' } };
    }

    if (!phoneValidation.isValid) {
      this.logger.warn(`[confirmation] classified invalid_or_non_whatsapp_number orderId=${normalizedOrder.orderId} reason=invalid_phone`);
      const cancelledOrder = await this.cancelOrderForInvalidPhone(orderPayload, now);
      return {
        status: 202,
        body: {
          ok: false,
          reason: 'invalid_or_non_whatsapp_number',
          cancelled: true,
          emailStatus: cancelledOrder.customerEmailStatus
        }
      };
    }

    const message = interpolateTemplate(this.messages.confirmationTemplate, buildTemplateValues(normalizedOrder));
    const acceptedAtFallback = now.toISOString();

    try {
      const sendOutcome = await this.sendLogicalMessageWithWooReservation({
        orderPayload,
        orderId: normalizedOrder.orderId,
        phone: normalizedOrder.phone,
        logicalKey: OUTBOUND_LOGICAL_KEYS.confirmationRequest,
        kind: 'confirmation_request',
        message,
        now,
        persistAfterSend: async ({ acceptedAt, providerMessageId, reservedAt }) => {
          const persistedOrder = await this.persistInitialConfirmationMeta({
            orderPayload,
            normalizedOrder,
            acceptedAt: acceptedAt || acceptedAtFallback,
            providerMessageId,
            reservedAt
          });
          await this.safeAddOrderNote(normalizedOrder.orderId, note);
          return persistedOrder;
        }
      });

      if (sendOutcome.deferred) {
        return { status: 202, body: { ok: true, deferred: true, reason: 'quiet_hours' } };
      }

      if (sendOutcome.inProgress || sendOutcome.duplicate) {
        return { status: 202, body: { ok: true, duplicate: true, reason: 'confirmation_in_flight' } };
      }

      if (!sendOutcome.persisted) {
        this.store.upsertOrder({
          ...normalizedOrder,
          rawOrder: orderPayload,
          confirmationState: 'pending_confirmation',
          confirmationSentAt: sendOutcome.acceptedAt || acceptedAtFallback,
          invalidReplyCount: 0,
          manualFollowupRequired: false,
          wasenderMessageId: sendOutcome.providerMessageId || '',
          lastError: sendOutcome.ambiguous ? 'ambiguous_send_state' : ''
        });
        return { status: 202, body: { ok: true, reason: 'ambiguous_send_state' } };
      }

      this.logger.log(`[confirmation] initial send accepted orderId=${normalizedOrder.orderId} phone=${maskPhone(normalizedOrder.phone)}`);
      await this.sendConfirmationPoll(normalizedOrder);

      return { status: 202, body: { ok: true } };
    } catch (error) {
      if (isWhatsAppContactabilityFailure(error)) {
        this.logger.warn(
          `[confirmation] classified invalid_or_non_whatsapp_number orderId=${normalizedOrder.orderId} status=${String(error.status || '')} body=${redactPhones(safeErrorData(error))}`
        );
        const cancelledOrder = await this.cancelOrderForUnreachableWhatsApp(orderPayload, error, now);
        return {
          status: 202,
          body: {
            ok: false,
            reason: 'invalid_or_non_whatsapp_number',
            cancelled: true,
            emailStatus: cancelledOrder.customerEmailStatus
          }
        };
      }

      this.logger.warn(
        `[confirmation] classified send_failed orderId=${normalizedOrder.orderId} status=${String(error.status || '')} message=${error.message}`
      );
      this.store.upsertOrder({
        ...normalizedOrder,
        confirmationState: 'send_failed',
        lastError: error.message
      });
      this.logger.error(error);
      // 200, not 5xx: the failure is recorded here and the hourly backfill tries again. A 5xx would make WooCommerce
      // count a failed delivery (and disable the webhook after a few), although the order itself was received fine.
      return { status: 200, body: { ok: false, reason: 'send_failed' } };
    }
  }

  async cancelOrderForUnreachableWhatsApp(orderPayload, error, now = new Date()) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    return this.cancelOrderWithReason({
      orderPayload,
      now,
      cancellationReason: 'invalid_or_non_whatsapp_number',
      logLabel: 'unreachable whatsapp',
      noteBuilder: (emailStatus) => buildUnreachableWhatsAppCancellationNote(emailStatus, error.message),
      errorMessage: error.message
    });
  }

  async cancelOrderForInvalidPhone(orderPayload, now = new Date()) {
    return this.cancelOrderWithReason({
      orderPayload,
      now,
      cancellationReason: 'invalid_or_non_whatsapp_number',
      logLabel: 'invalid phone',
      noteBuilder: buildUnreachableWhatsAppCancellationNote,
      errorMessage: 'Phone number is invalid or not reachable on WhatsApp'
    });
  }

  async cancelOrderWithReason({ orderPayload, now, cancellationReason, logLabel, noteBuilder, errorMessage }) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const nowIso = now.toISOString();
    this.logger.log(`[confirmation] cancelling ${logLabel} orderId=${normalizedOrder.orderId}`);
    const statusUpdatedOrder = await this.wooClient.updateOrderStatus(normalizedOrder.orderId, WOO_STATUS.cancelled);
    const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
      normalizedOrder.orderId,
      mergeMetaUpdates(
        buildWorkflowMetaUpdate(statusUpdatedOrder || orderPayload, {
          state: WORKFLOW_STATE.cancelled,
          cancelledAt: nowIso
        }),
        buildDecisionMetaUpdate(statusUpdatedOrder || orderPayload, {
          decision: DECISION.cancelled,
          decisionAt: nowIso,
          wooSyncStatus: WOO_SYNC_STATUS.synced,
          wooSyncAttempts: 0,
          lastSyncError: '',
          customerReplySent: 'no',
          cancellationReason
        })
      )
    );

    const emailResult = await this.sendCancellationEmail(normalizedOrder);
    this.logger.log(
      `[confirmation] cancel completed orderId=${normalizedOrder.orderId} emailStatus=${emailResult.status} wooStatus=cancelled`
    );
    await this.safeAddOrderNote(normalizedOrder.orderId, noteBuilder(emailResult.status));

    return this.store.upsertOrder({
      ...normalizedOrder,
      rawOrder: metaUpdatedOrder || statusUpdatedOrder || orderPayload,
      confirmationState: 'cancelled',
      wooStatus: WOO_STATUS.cancelled,
      decision: DECISION.cancelled,
      decisionAt: nowIso,
      wooSyncStatus: WOO_SYNC_STATUS.synced,
      wooSyncAttempts: 0,
      lastSyncError: '',
      customerReplySent: 'no',
      cancellationReason,
      customerEmailStatus: emailResult.status,
      customerEmailError: emailResult.error || '',
      lastError: errorMessage
    });
  }

  async safeAddOrderNote(orderId, note) {
    try {
      await this.wooClient.addOrderNote(orderId, note);
    } catch (error) {
      this.logger.warn(`Unable to add WooCommerce note for order ${orderId}: ${error.message}`);
    }
  }

  // Always judged on the real clock, not on the time an order or decision was recorded.
  isQuietNow() {
    return isQuietHours(this.clock(), this.quietHours);
  }

  async sendCancellationEmail(order) {
    if (!order.customerEmail) {
      this.logger.warn(`[confirmation] cancellation email skipped orderId=${order.orderId} reason=missing_customer_email`);
      return { status: 'skipped', error: '' };
    }

    const subject = interpolateTemplate(this.messages.cancellationEmailSubject, buildTemplateValues(order));
    const text = interpolateTemplate(this.messages.cancellationEmailBody, buildTemplateValues(order));

    try {
      if (!this.mailService) {
        throw new Error('Mail service is not configured');
      }

      this.logger.log(`[confirmation] sending cancellation email orderId=${order.orderId} to=${maskEmail(order.customerEmail)}`);
      await this.mailService.send({
        to: order.customerEmail,
        subject,
        text
      });
      this.logger.log(`[confirmation] cancellation email sent orderId=${order.orderId} to=${maskEmail(order.customerEmail)}`);
      return { status: 'sent', error: '' };
    } catch (error) {
      this.logger.warn(`Unable to send cancellation email for order ${order.orderId}: ${error.message}`);
      return { status: 'failed', error: error.message };
    }
  }

  async sendInternalDecisionNotifications({ order, decision, alreadyNotified }) {
    if (alreadyNotified) {
      return order;
    }

    const template = decision === DECISION.confirmed
      ? this.messages.internalConfirmedTemplate
      : this.messages.internalCancelledTemplate;
    const message = interpolateTemplate(template, buildTemplateValues(order));
    const failedPhones = [];

    for (const phone of this.messages.internalNotifyPhones || []) {
      try {
        const result = await this.wasenderClient.sendMessage({
          to: phone,
          message
        });
        this.store.appendMessage({
          source: 'outbound',
          orderId: order.orderId,
          phone,
          kind: decision === DECISION.confirmed ? 'internal_confirmed_notification' : 'internal_cancelled_notification',
          payload: result,
          text: message
        });
      } catch (error) {
        this.logger.warn(`Unable to send internal ${decision} notification for order ${order.orderId} to ${maskPhone(phone)}: ${error.message}`);
        failedPhones.push(phone);
      }
    }

    if (failedPhones.length) {
      this.logger.warn(`[confirmation] internal ${decision} notifications incomplete orderId=${order.orderId} failedPhones=${failedPhones.map((item) => maskPhone(item)).join(',')}`);
      return this.store.upsertOrder({
        ...order,
        internalNotifiedConfirmed: decision === DECISION.confirmed ? 'no' : order.internalNotifiedConfirmed || 'no',
        internalNotifiedCancelled: decision === DECISION.cancelled ? 'no' : order.internalNotifiedCancelled || 'no'
      });
    }

    const nextOrder = this.store.upsertOrder({
      ...order,
      internalNotifiedConfirmed: decision === DECISION.confirmed ? 'yes' : order.internalNotifiedConfirmed || 'no',
      internalNotifiedCancelled: decision === DECISION.cancelled ? 'yes' : order.internalNotifiedCancelled || 'no'
    });

    try {
      const updatedOrder = await this.wooClient.updateOrderMeta(
        order.orderId,
        buildDecisionMetaUpdate(order.rawOrder || {}, {
          internalNotifiedConfirmed: decision === DECISION.confirmed ? 'yes' : nextOrder.internalNotifiedConfirmed || 'no',
          internalNotifiedCancelled: decision === DECISION.cancelled ? 'yes' : nextOrder.internalNotifiedCancelled || 'no'
        })
      );

      return this.store.upsertOrder({
        ...nextOrder,
        rawOrder: updatedOrder || nextOrder.rawOrder
      });
    } catch (error) {
      this.logger.warn(`Unable to persist internal notification flag for order ${order.orderId}: ${error.message}`);
      return nextOrder;
    }
  }

  // Hands a confirmed order to the HighDelivery auto-send without holding up the WhatsApp webhook answer.
  // The auto-send never throws and leaves the order on-hold whenever anything goes wrong.
  scheduleHdAutoSend(order) {
    if (!this.hdAutoSend?.enabled) {
      return null;
    }
    // Started outside the lock it is usually called in (the reply, the hourly run): it must queue, not re-enter.
    const task = outsideLocks(() => Promise.resolve()
      .then(() => this.hdAutoSend.autoSend(order))
      .catch((error) => this.logger.warn(`[hd-auto-send] unexpected failure orderId=${order?.orderId}: ${error.message}`))
      .finally(() => this.backgroundTasks.delete(task)));
    this.backgroundTasks.add(task);
    return task;
  }

  // Resolves when every tracked background task is done: inbound Wasender messages still being handled, HighDelivery
  // auto-sends, and first confirmations whose timer already fired. Tasks started meanwhile are waited for too. Timers
  // that have not fired are not waited for (see flushDueConfirmations). Never rejects.
  async drain() {
    while (this.backgroundTasks.size) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  drainBackgroundTasks() {
    return this.drain();
  }

  async markManualOverride({ order, status }) {
    return this.withOrderLock(order.orderId, async () => {
      // Judged on the order as it is now: the service's own writes (decision, then status) may have landed meanwhile.
      let current = order.rawOrder || {};
      if (typeof this.wooClient.getOrder === 'function') {
        try {
          current = (await this.wooClient.getOrder(order.orderId)) || current;
        } catch (error) {
          this.logger.warn(`[confirmation] manual override check could not re-read orderId=${order.orderId}: ${error.message}`);
        }
      }
      const currentDecision = getDecisionMeta(current);
      const decision = currentDecision.decision || order.decision || '';
      const currentStatus = String(current.status || status || '');
      if (decision && isExpectedStatusForDecision(currentStatus, decision, this.wooStatuses)) {
        return false;
      }
      if (currentDecision.manualOverride === 'yes' && currentDecision.manualOverrideStatus === String(status || '')) {
        // Already recorded: nothing to rewrite, no second note.
        return true;
      }
      const normalizedOrder = {
        ...order,
        rawOrder: current,
        manualOverride: 'yes',
        manualOverrideAt: new Date().toISOString(),
        manualOverrideStatus: status,
        confirmationState: 'manual',
        wooSyncStatus: WOO_SYNC_STATUS.manual
      };

      this.store.upsertOrder(normalizedOrder);

      try {
        const updatedOrder = await this.wooClient.updateOrderMeta(
          normalizedOrder.orderId,
          mergeMetaUpdates(
            buildWorkflowMetaUpdate(normalizedOrder.rawOrder || {}, {
              state: WORKFLOW_STATE.manual
            }),
            buildDecisionMetaUpdate(normalizedOrder.rawOrder || {}, {
              decision: normalizedOrder.decision || '',
              decisionAt: normalizedOrder.decisionAt || '',
              wooSyncStatus: WOO_SYNC_STATUS.manual,
              wooSyncAttempts: normalizedOrder.wooSyncAttempts || 0,
              lastSyncError: normalizedOrder.lastSyncError || '',
              customerReplySent: normalizedOrder.customerReplySent || 'no',
              manualOverride: 'yes',
              manualOverrideAt: normalizedOrder.manualOverrideAt,
              manualOverrideStatus: status
            })
          )
        );

        this.store.upsertOrder({
          ...normalizedOrder,
          rawOrder: updatedOrder || normalizedOrder.rawOrder
        });
        await this.safeAddOrderNote(normalizedOrder.orderId, 'WhatsApp workflow stopped due to manual WooCommerce status change.');
      } catch (error) {
        this.logger.warn(`Unable to persist manual override for order ${normalizedOrder.orderId}: ${error.message}`);
      }

      return true;
    });
  }

  async listOrdersForStatuses(statuses, options = {}) {
    if (typeof this.wooClient.listOrdersByStatuses === 'function') {
      return this.wooClient.listOrdersByStatuses(statuses, options);
    }

    const allOrders = [];
    const seenOrderIds = new Set();

    for (const status of statuses) {
      let page = 1;
      const perPage = 100;

      while (true) {
        const orders = await this.wooClient.listOrders({
          status,
          perPage,
          page
        });

        if (!orders.length) {
          break;
        }

        for (const order of orders) {
          if (seenOrderIds.has(String(order.id))) {
            continue;
          }
          seenOrderIds.add(String(order.id));
          allOrders.push(order);
        }

        if (orders.length < perPage) {
          break;
        }
        page += 1;
      }
    }

    return allOrders;
  }

  async findPendingWooOrdersByPhone(phone) {
    // Only recent orders can still wait for an answer (the last reminder is about 4 days after the order), and the read is
    // capped: a reply never scans the whole shop.
    const candidateOrders = await this.listOrdersForStatuses(REPLY_RECOVERY_STATUSES, {
      after: new Date(Date.now() - REPLY_LOOKBACK_MS).toISOString(),
      maxPages: REPLY_LOOKUP_MAX_PAGES
    });

    return candidateOrders
      .filter((order) => {
        const workflow = getWorkflowMeta(order);
        const decisionMeta = getDecisionMeta(order);
        const normalizedOrder = normalizeWooOrder(order, this.messages);

        return normalizedOrder.phone === phone
          && workflow.state === WORKFLOW_STATE.pending
          && Boolean(workflow.confirmationSentAt)
          && !decisionMeta.decision;
      })
      .sort(compareOrdersByRecency);
  }

  async persistDecisionMeta({
    orderPayload,
    orderId,
    state,
    nowIso,
    customerReplySent,
    wooSyncStatus,
    wooSyncAttempts,
    lastSyncError
  }) {
    return this.wooClient.updateOrderMeta(
      orderId,
      mergeMetaUpdates(
        buildWorkflowMetaUpdate(orderPayload, {
          state,
          cancelledAt: state === DECISION.cancelled ? nowIso : ''
        }),
        buildDecisionMetaUpdate(orderPayload, {
          decision: state,
          decisionAt: nowIso,
          wooSyncStatus,
          wooSyncAttempts,
          lastSyncError,
          customerReplySent,
          lastConfirmationMessageKey: getDecisionMeta(orderPayload).lastConfirmationMessageKey || ''
        })
      )
    );
  }

  async reconcileWooDecision({ order, targetState, targetWooStatus, note, nowIso }) {
    return this.withOrderLock(order.orderId, async () => {
      const currentAttempts = Number(order.wooSyncAttempts || getDecisionMeta(order.rawOrder || {}).wooSyncAttempts || 0);
      const attemptNumber = currentAttempts + 1;
      let rawOrder = order.rawOrder || {};

      try {
        const updatedOrder = await this.wooClient.updateOrder(order.orderId, {
          status: targetWooStatus,
          meta_data: mergeMetaUpdates(
            buildWorkflowMetaUpdate(rawOrder, {
              state: targetState,
              cancelledAt: targetState === DECISION.cancelled ? nowIso : ''
            }),
            buildDecisionMetaUpdate(rawOrder, {
              decision: targetState,
              decisionAt: nowIso,
              wooSyncStatus: WOO_SYNC_STATUS.synced,
              wooSyncAttempts: attemptNumber,
              lastSyncError: '',
              customerReplySent: order.customerReplySent || 'no'
            })
          )
        });
        rawOrder = updatedOrder || rawOrder;
        await this.safeAddOrderNote(order.orderId, note);
        this.store.upsertOrder({
          ...order,
          rawOrder,
          confirmationState: targetState,
          wooStatus: targetWooStatus,
          decision: targetState,
          decisionAt: nowIso,
          wooSyncStatus: WOO_SYNC_STATUS.synced,
          wooSyncAttempts: attemptNumber,
          lastSyncError: ''
        });
        return { success: true, syncStatus: WOO_SYNC_STATUS.synced, rawOrder };
      } catch (error) {
        const syncStatus = attemptNumber >= MAX_WOO_SYNC_ATTEMPTS ? WOO_SYNC_STATUS.manual : WOO_SYNC_STATUS.pendingRetry;
        this.store.upsertOrder({
          ...order,
          confirmationState: targetState,
          decision: targetState,
          decisionAt: order.decisionAt || nowIso,
          wooSyncStatus: syncStatus,
          wooSyncAttempts: attemptNumber,
          lastSyncError: error.message
        });
        try {
          await this.wooClient.updateOrderStatus(order.orderId, targetWooStatus);
        } catch (statusError) {
          this.logger.warn(`[confirmation] status-only fallback failed for order ${order.orderId}: ${statusError.message}`);
        }
        try {
          const metaUpdatedOrder = await this.persistDecisionMeta({
            orderPayload: rawOrder,
            orderId: order.orderId,
            state: targetState,
            nowIso: order.decisionAt || nowIso,
            customerReplySent: order.customerReplySent || 'no',
            wooSyncStatus: syncStatus,
            wooSyncAttempts: attemptNumber,
            lastSyncError: error.message
          });
          this.store.upsertOrder({
            ...order,
            rawOrder: metaUpdatedOrder || rawOrder,
            confirmationState: targetState,
            decision: targetState,
            decisionAt: order.decisionAt || nowIso,
            wooSyncStatus: syncStatus,
            wooSyncAttempts: attemptNumber,
            lastSyncError: error.message
          });
        } catch (metaError) {
          this.logger.warn(`Unable to persist Woo sync failure for order ${order.orderId}: ${metaError.message}`);
        }
        this.logger.error(error);
        return { success: false, syncStatus, error };
      }
    });
  }
}

// The service methods split out by area run with the service as `this` (pure moves).
Object.assign(ConfirmationService.prototype, reservedSendMethods);
Object.assign(ConfirmationService.prototype, followupMethods);
Object.assign(ConfirmationService.prototype, feedbackMethods);
Object.assign(ConfirmationService.prototype, optOutMethods);
Object.assign(ConfirmationService.prototype, ordersReadModelMethods);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// { done: true, value | error } when the promise settles within ms, otherwise { done: false } after ms.
function settleWithin(promise, ms) {
  let timer;
  const outcome = promise.then((value) => ({ done: true, value }), (error) => ({ done: true, error }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
    timer.unref?.();
  });
  return Promise.race([outcome, timeout]).finally(() => clearTimeout(timer));
}

function hashPayload(value) {
  try {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  } catch {
    return createHash('sha256').update(String(value || '')).digest('hex');
  }
}

function isWhatsAppContactabilityFailure(error) {
  if (!(error instanceof WasenderSendError)) {
    return false;
  }

  if (![400, 404, 422].includes(Number(error.status))) {
    return false;
  }

  const haystack = JSON.stringify(error.data || {}).toLowerCase();
  return [
    'not on whatsapp',
    'not registered on whatsapp',
    'not connected to whatsapp',
    'not a valid whatsapp',
    'invalid phone',
    'invalid number',
    'number is invalid',
    'phone number is invalid',
    'invalid recipient',
    'recipient does not exist',
    'unreachable',
    'jid'
  ].some((pattern) => haystack.includes(pattern));
}

// `detail` is the WhatsApp provider's answer (already redacted by the Wasender client), when there is one.
function buildUnreachableWhatsAppCancellationNote(emailStatus, detail = '') {
  const reason = detail ? ` (${redact(String(detail)).slice(0, 160)})` : '';
  const head = `Order cancelled automatically because the provided phone number is invalid or not reachable on WhatsApp${reason}.`;
  if (emailStatus === 'sent') {
    return `${head} Customer email notification sent.`;
  }

  if (emailStatus === 'skipped') {
    return `${head} Customer email notification skipped because no billing email was available.`;
  }

  return `${head} Customer email notification failed.`;
}

function safeErrorData(error) {
  try {
    return JSON.stringify(error?.data ?? null);
  } catch {
    return '"[unserializable]"';
  }
}

// Newest order first. A cached order may have lost its dates (it was re-saved from a partial answer), so when either date
// is missing the order number decides: WooCommerce numbers grow with time.
function compareNewestFirst(left, right) {
  const createdMs = (order) => {
    const source = order.rawOrder || order;
    const parsed = Date.parse(String(source?.date_created_gmt || source?.date_created || ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const leftMs = createdMs(left);
  const rightMs = createdMs(right);
  if (leftMs > 0 && rightMs > 0 && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  return Number(right.orderId) - Number(left.orderId);
}

function isSameFinalDecision(order, inbound) {
  if (inbound.type !== 'text') {
    return false;
  }

  const reply = parseDecisionReply(inbound.text);
  if (reply !== '1' && reply !== '2') {
    return false;
  }

  const decisionMeta = getDecisionMeta(order.rawOrder || {});
  const decision = order.decision || decisionMeta.decision || '';
  return (reply === '1' && decision === DECISION.confirmed) || (reply === '2' && decision === DECISION.cancelled);
}
