import { createHash } from 'node:crypto';
import {
  FEEDBACK_META_KEYS,
  HD_META,
  HD_PARCEL_TRACE_META,
  OUTBOUND_LOGICAL_KEYS,
  OUTBOUND_META_KEYS,
  outboundClaimKey
} from '../domain/order-meta.js';
import {
  ACTIVE_CONFIRMATION_STATUSES,
  assertTransition,
  DECISION,
  FEEDBACK_MATCH_STATUSES,
  FOLLOWUP_CLOSED_STATUSES,
  HD_STATE,
  OUTBOUND_SEND,
  RECONCILIATION_STATUSES,
  SEND_STATE,
  WOO_STATUS,
  WOO_SYNC_STATUS,
  WORKFLOW_STATE
} from '../domain/order-states.js';
import {
  interpolateTemplate,
  maskEmail,
  maskPhone,
  normalizePhone,
  redactPhones,
  validatePhone
} from '../utils/format.js';
import { DEFAULT_WOO_STATUSES, wooStatusMatchesTarget } from '../utils/hd-status.js';
import { KeyedLock } from '../utils/keyed-lock.js';
import { isOptOutMessage } from '../utils/opt-out.js';
import { isQuietHours } from '../utils/quiet-hours.js';
import { claim, DEFAULT_CLAIM_SETTLE_MS, INSTANCE_ID } from './claim.js';
import {
  buildDecisionMetaUpdate,
  buildLogicalSendMetaUpdate,
  buildTemplateValues,
  buildWorkflowMetaUpdate,
  classifyFeedbackToken,
  compareOrdersByRecency,
  getDecisionMeta,
  getFeedbackMeta,
  getOutboundReservationMeta,
  getWorkflowMeta,
  hasConfirmationWorkflowStarted,
  isConfirmationAlreadyStarted,
  isExpectedStatusForDecision,
  isFeedbackSelfTestOrder,
  mergeMetaUpdates,
  normalizeFeedbackTokenValue,
  normalizeWooOrder,
  resolveDeliveryEta
} from './confirmation/order-helpers.js';
import { WasenderSendError } from './wasender-client.js';

const REPLY_RECOVERY_STATUSES = [...ACTIVE_CONFIRMATION_STATUSES];
const FEEDBACK_RECOVERY_PER_PAGE = 50;
const FEEDBACK_RECOVERY_MAX_PAGES = 2;
const BACKFILL_MAX_ORDER_AGE_MS = 72 * 60 * 60 * 1000;
const FIRST_REMINDER_MS = 24 * 60 * 60 * 1000;
const SECOND_REMINDER_MS = 48 * 60 * 60 * 1000;
const AUTO_CANCEL_AFTER_SECOND_REMINDER_MS = 24 * 60 * 60 * 1000;
const MAX_WOO_SYNC_ATTEMPTS = 6;
const MAX_FEEDBACK_PAYLOAD_JSON_LENGTH = 4000;
const INBOUND_MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const OUTBOUND_RESERVATION_STALE_MS = 2 * 60 * 60 * 1000;
// The Wasender webhook is answered after at most this long; the work goes on in the background.
const DEFAULT_INBOUND_ACK_BUDGET_MS = 1000;

export class ConfirmationService {
  constructor({ store, wasenderClient, wooClient, mailService = null, wordpressClient = null, optOutKeywords = null, hdAutoSend = null, messages, wooStatuses = DEFAULT_WOO_STATUSES, durableState = null, notifyTeam = null, sleep = defaultSleep, claimSettleMs = DEFAULT_CLAIM_SETTLE_MS, instanceId = INSTANCE_ID, inboundAckBudgetMs = DEFAULT_INBOUND_ACK_BUDGET_MS, logger = console }) {
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

    const timer = setTimeout(() => this.startDelayedInitialConfirmation(payload, key), delayMs);
    this.pendingInitialConfirmations.set(key, timer);
    this.initialConfirmationDueAt.set(key, { dueAt: Date.now() + delayMs, payload });
    this.logger.log(`[confirmation] initial send scheduled orderId=${key} delayMs=${delayMs}`);

    return { status: 202, body: { ok: true, scheduled: true, delayMs } };
  }

  // The timer fired (or a shutdown flush found it due): the send runs as a tracked background task, and the order stays
  // in pendingInitialConfirmations until it is done, so the hourly backfill never sends it as well.
  startDelayedInitialConfirmation(payload, key) {
    this.initialConfirmationDueAt.delete(key);
    const run = this.runDelayedInitialConfirmation(payload, key)
      .catch((error) => this.logger.error(error))
      .finally(() => this.pendingInitialConfirmations.delete(key));
    return this.trackBackground(run, `first confirmation ${key}`);
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

  async processWooOrder(payload, eventKey) {
    if (this.inFlightWooEvents.has(eventKey)) {
      this.safeRecordEvent('woocommerce', eventKey, payload, 'duplicate_order');
      return { status: 200, body: { ok: true, duplicate: true, reason: 'event_in_flight' } };
    }
    this.inFlightWooEvents.set(eventKey, Date.now());

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
  trackBackground(promise, label = 'background task') {
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

  async handleOptOut(message) {
    const phone = message.senderPhone;
    const now = new Date().toISOString();
    const lastMessageText = message.textBody || message.captionText || '';

    this.store.upsertContact({
      phone,
      marketingStatus: 'opted_out',
      optedOutAt: now,
      optOutSource: 'inbound_whatsapp',
      lastMessageText,
      lastMessageAt: message.timestamp || now
    });

    let savedDurably = false;
    if (this.durableState) {
      try {
        savedDurably = await this.durableState.recordOptOut(phone, now);
      } catch (error) {
        this.logger.warn(`[opt-out] durable save failed phone=${maskPhone(phone)}: ${error.message}`);
      }
    }

    await this.persistOptOutToLatestWooOrder({
      phone,
      replyText: lastMessageText,
      optedOutAt: now,
      messageKey: message.messageKey
    });

    if (!savedDurably && !this.wordpressClient?.isConfigured) {
      this.logger.warn(
        `[opt-out] Opt-out saved only locally for now (WooCommerce not reachable; retried on the next write). phone=${maskPhone(phone)} messageKey=${message.messageKey}`
      );
    }
    if (this.wordpressClient?.isConfigured) {
      this.wordpressClient
        .optOutContact(phone, {
          optOutSource: 'inbound_whatsapp',
          lastMessageText,
          providerMessageId: message.providerMessageId || null,
          messageKey: message.messageKey
        })
        .catch((err) => {
          this.logger.warn(`[opt-out] wordpress_sync_failed phone=${maskPhone(phone)} messageKey=${message.messageKey} error=${err.message}`);
        });
    }

    this.logger.log(
      `[opt-out] phone=${maskPhone(phone)} messageKey=${message.messageKey} source=inbound_whatsapp text=${JSON.stringify(lastMessageText)}`
    );

    return {
      ok: true,
      ignored: false,
      duplicate: false,
      failed: false,
      route: 'opt_out',
      eventStatus: 'opt_out'
    };
  }

  async persistOptOutToLatestWooOrder({ phone, replyText, optedOutAt, messageKey }) {
    try {
      const orders = await this.listOrdersForStatuses(RECONCILIATION_STATUSES);
      const matches = orders
        .filter((order) => normalizeWooOrder(order, this.messages).phone === phone)
        .sort(compareOrdersByRecency);

      const latestOrder = matches[0];
      if (!latestOrder) {
        this.logger.warn(`[opt-out] no_matching_woo_order phone=${maskPhone(phone)} messageKey=${messageKey}`);
        return;
      }

      const note = buildOptOutWooOrderNote({
        replyText,
        optedOutAt
      });
      await this.safeAddOrderNote(String(latestOrder.id), note);
      this.logger.log(`[opt-out] woo_marker_saved phone=${maskPhone(phone)} orderId=${latestOrder.id} messageKey=${messageKey}`);
    } catch (error) {
      this.logger.warn(`[opt-out] woo_marker_failed phone=${maskPhone(phone)} messageKey=${messageKey} error=${error.message}`);
    }
  }

  async processFeedbackMatchResult(message, feedbackMatch) {
    if (feedbackMatch.kind === 'matched') {
      return this.processFeedbackInboundMessage(message, feedbackMatch);
    }

    this.appendInboundMessage({
      message,
      orderId: null,
      storedKind: `feedback_${message.kind || 'unknown'}`
    });

    return {
      ok: true,
      ignored: true,
      duplicate: false,
      failed: false,
      route: 'feedback',
      eventStatus: feedbackMatch.kind === 'ambiguous'
        ? 'feedback_match_ambiguous'
        : 'feedback_unmatched'
    };
  }

  async routeConfirmationInboundMessage(message, options = {}, replyContext = null) {
    if (!message.senderPhone || !isConfirmationMessageKind(message.kind)) {
      return null;
    }

    const resolvedReplyContext = replyContext || await this.resolveReplyContext(
      message.senderPhone,
      { allowWooRecovery: options.allowWooRecovery !== false }
    );
    if (resolvedReplyContext.pendingOrders.length > 1) {
      this.logger.warn(
        `[confirmation] multiple pending orders require manual follow-up senderPhone=${maskPhone(message.senderPhone)} candidateOrderIds=${resolvedReplyContext.pendingOrders.map((order) => order.orderId).join(',')} messageKey=${message.messageKey}`
      );
      this.appendInboundMessage({
        message,
        orderId: resolvedReplyContext.latestOrder?.orderId || null,
        storedKind: message.kind === 'audio' ? 'customer_audio_reply' : 'customer_reply'
      });
      return {
        ok: false,
        ignored: true,
        duplicate: false,
        failed: false,
        route: 'confirmation',
        eventStatus: 'manual_followup_required',
        reason: 'multiple_pending_orders'
      };
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
      const reply = message.kind === 'audio' ? '' : String(message.textBody || '').trim();
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

  async matchFeedbackOrder(message, { token = '', explicitToken = false } = {}) {
    if (!explicitToken) {
      if (!message.senderPhone) {
        return { kind: 'unmatched', source: 'production_phone', reason: 'missing_sender_phone' };
      }

      const localCandidates = this.store.listActiveSelfTestFeedbackOrdersByPhone(message.senderPhone);
      if (localCandidates.length) {
        return {
          kind: 'matched',
          orderId: String(localCandidates[0].orderId),
          source: 'self_test_phone_local',
          matchedOrderIds: localCandidates.map((order) => String(order.orderId))
        };
      }

      const recoveredMatch = await this.recoverLatestSelfTestFeedbackOrderByPhone(message.senderPhone);
      if (recoveredMatch) {
        return recoveredMatch;
      }

      const localProductionCandidates = this.store.listActiveProductionFeedbackOrdersByPhone(message.senderPhone);
      if (localProductionCandidates.length) {
        return {
          kind: 'matched',
          orderId: String(localProductionCandidates[0].orderId),
          source: 'production_phone_local',
          matchedOrderIds: localProductionCandidates.map((order) => String(order.orderId))
        };
      }

      const recoveredProductionMatch = await this.recoverLatestProductionFeedbackOrderByPhone(message.senderPhone);
      if (recoveredProductionMatch) {
        return recoveredProductionMatch;
      }

      return { kind: 'unmatched', source: 'production_phone', reason: 'no_active_feedback_candidate' };
    }

    if (explicitToken) {
      const parsedToken = classifyFeedbackToken(token);
      if (!parsedToken) {
        return { kind: 'unmatched', source: 'token' };
      }

      if (parsedToken.type === 'numeric') {
        try {
          const order = await this.wooClient.getOrder(parsedToken.orderId);
          return { kind: 'matched', orderId: String(parsedToken.orderId), order, source: 'numeric_token' };
        } catch (error) {
          this.logger.warn(
            `[feedback] unable to resolve numeric token orderId=${parsedToken.orderId} messageKey=${message.messageKey} error=${error.message}`
          );
          return { kind: 'unmatched', source: 'numeric_token' };
        }
      }

      const orders = await this.findFeedbackOrdersByToken(parsedToken.value);
      if (orders.length === 1) {
        const feedbackMeta = getFeedbackMeta(orders[0]);
        this.logger.log(
          `[feedback] self-test token matched token=${parsedToken.value} orderId=${String(orders[0].id)} runId=${feedbackMeta.testRunId || ''} wooStatus=${String(orders[0].status || '')} messageKey=${message.messageKey}`
        );
        return {
          kind: 'matched',
          orderId: String(orders[0].id),
          order: orders[0],
          source: 'self_test_token',
          matchedOrderIds: [String(orders[0].id)]
        };
      }
      if (orders.length > 1) {
        this.logger.warn(
          `[feedback] ambiguous self-test token token=${parsedToken.value} matches=${orders.map((order) => order.id).join(',')} messageKey=${message.messageKey}`
        );
        return { kind: 'ambiguous', source: 'self_test_token', matchedOrderIds: orders.map((order) => String(order.id)) };
      }

      this.logger.warn(
        `[feedback] unmatched self-test token token=${parsedToken.value} searchedStatuses=${FEEDBACK_MATCH_STATUSES.join(',')} messageKey=${message.messageKey}`
      );
      return { kind: 'unmatched', source: 'self_test_token' };
    }
  }

  async recoverLatestSelfTestFeedbackOrderByPhone(phone) {
    const seenOrderIds = new Set();
    const matches = [];

    for (const status of FEEDBACK_MATCH_STATUSES) {
      for (let page = 1; page <= FEEDBACK_RECOVERY_MAX_PAGES; page += 1) {
        const orders = await this.wooClient.listOrders({
          status,
          perPage: FEEDBACK_RECOVERY_PER_PAGE,
          page
        });

        if (!orders.length) {
          break;
        }

        for (const order of orders) {
          const orderId = String(order.id);
          if (seenOrderIds.has(orderId)) {
            continue;
          }
          seenOrderIds.add(orderId);

          const feedbackMeta = getFeedbackMeta(order);
          if (!isFeedbackSelfTestOrder(order) || feedbackMeta.testPhone !== phone) {
            continue;
          }

          matches.push(order);
        }

        if (orders.length < FEEDBACK_RECOVERY_PER_PAGE) {
          break;
        }
      }
    }

    if (!matches.length) {
      return null;
    }

    const sortedMatches = matches.sort(compareSelfTestFeedbackCandidates);
    const chosenOrder = sortedMatches[0];
    this.store.upsertOrder({
      ...normalizeWooOrder(chosenOrder, this.messages),
      rawOrder: chosenOrder
    });

    return {
      kind: 'matched',
      orderId: String(chosenOrder.id),
      source: 'self_test_phone_woo_recovery',
      matchedOrderIds: sortedMatches.map((order) => String(order.id))
    };
  }

  async recoverLatestProductionFeedbackOrderByPhone(phone) {
    const seenOrderIds = new Set();
    const matches = [];

    for (const status of FEEDBACK_MATCH_STATUSES) {
      for (let page = 1; page <= FEEDBACK_RECOVERY_MAX_PAGES; page += 1) {
        const orders = await this.wooClient.listOrders({
          status,
          perPage: FEEDBACK_RECOVERY_PER_PAGE,
          page
        });

        if (!orders.length) {
          break;
        }

        for (const order of orders) {
          const orderId = String(order.id);
          if (seenOrderIds.has(orderId)) {
            continue;
          }
          seenOrderIds.add(orderId);

          if (!isProductionFeedbackOrder(order, this.messages, phone)) {
            continue;
          }

          matches.push(order);
        }

        if (orders.length < FEEDBACK_RECOVERY_PER_PAGE) {
          break;
        }
      }
    }

    if (!matches.length) {
      return null;
    }

    const sortedMatches = matches.sort(compareFeedbackCandidates);
    const chosenOrder = sortedMatches[0];
    this.store.upsertOrder({
      ...normalizeWooOrder(chosenOrder, this.messages),
      rawOrder: chosenOrder
    });

    return {
      kind: 'matched',
      orderId: String(chosenOrder.id),
      source: 'production_phone_woo_recovery',
      matchedOrderIds: sortedMatches.map((order) => String(order.id))
    };
  }

  async processFeedbackInboundMessage(message, feedbackMatch) {
    let feedbackOrder = feedbackMatch.order || await this.wooClient.getOrder(feedbackMatch.orderId);
    const normalizedOrder = normalizeWooOrder(feedbackOrder, this.messages);
    const localOrder = this.store.getOrder(normalizedOrder.orderId);
    this.appendInboundMessage({
      message,
      orderId: normalizedOrder.orderId,
      storedKind: `feedback_${message.kind || 'unknown'}`
    });

    const result = await this.withOrderLock(normalizedOrder.orderId, async () => {
      // Read again inside the lock: the reply may already be recorded (a webhook retry, or a restart in between).
      if (feedbackMatch.order) {
        try {
          feedbackOrder = (await this.wooClient.getOrder(normalizedOrder.orderId)) || feedbackOrder;
        } catch (error) {
          this.logger.warn(`[feedback] could not re-read orderId=${normalizedOrder.orderId}: ${error.message}`);
        }
      }
      const replyAt = resolveInboundTimestamp(message.timestamp);
      const providerMessageId = message.providerMessageId || message.messageKey;
      const feedbackMeta = getFeedbackMeta(feedbackOrder);

      if (feedbackMeta.replyLastMessageId && feedbackMeta.replyLastMessageId === providerMessageId) {
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'feedback',
          eventStatus: 'feedback_duplicate'
        };
      }

      const replyCount = Number(feedbackMeta.replyCount || 0) + 1;
      const payloadJson = buildReducedPayloadSnapshot(message);

      let updatedOrder;
      try {
        updatedOrder = await this.wooClient.updateOrderMeta(
          normalizedOrder.orderId,
          buildFeedbackMetaUpdate(feedbackOrder, {
            state: 'reply_received',
            replyAt,
            replyLastMessageId: providerMessageId,
            replyCount,
            senderPhone: message.senderPhone || message.senderRaw || '',
            lastKind: message.kind,
            lastText: message.textBody || '',
            lastCaption: message.captionText || '',
            lastMediaUrl: message.mediaRef || '',
            lastMimeType: message.mimeType || '',
            payloadJson
          })
        );
      } catch (error) {
        this.logger.warn(
          `[feedback] failed Woo meta update orderId=${normalizedOrder.orderId} wooBaseUrl=${String(this.wooClient?.baseUrl || '')} senderPhone=${maskPhone(message.senderPhone)} senderRaw=${redactPhones(message.senderRaw)} recipient=${redactPhones(message.recipientRaw)} messageKey=${message.messageKey} error=${error.message}`
        );
        return {
          ok: false,
          ignored: false,
          duplicate: false,
          failed: true,
          route: 'feedback',
          eventStatus: 'feedback_woo_update_failed',
          reason: error.message
        };
      }

      try {
        await this.wooClient.addOrderNote(normalizedOrder.orderId, buildFeedbackNote(message));
      } catch (error) {
        this.logger.warn(`[feedback] failed Woo note orderId=${normalizedOrder.orderId} messageKey=${message.messageKey} error=${error.message}`);
      }

      this.store.upsertOrder({
        ...localOrder,
        ...normalizeWooOrder(updatedOrder || feedbackOrder, this.messages),
        rawOrder: updatedOrder || feedbackOrder,
        feedbackState: 'reply_received',
        feedbackReplyAt: replyAt,
        feedbackReplyLastMessageId: providerMessageId,
        feedbackReplyCount: replyCount,
        feedbackSenderPhone: message.senderPhone || message.senderRaw || '',
        feedbackLastKind: message.kind,
        feedbackLastText: message.textBody || '',
        feedbackLastCaption: message.captionText || '',
        feedbackLastMediaUrl: message.mediaRef || '',
        feedbackLastMimeType: message.mimeType || ''
      });

      return {
        ok: true,
        ignored: false,
        duplicate: false,
        failed: false,
        route: 'feedback',
        eventStatus: 'feedback_reply_received'
      };
    });

    return result;
  }

  async findFeedbackOrdersByToken(token) {
    const orders = await this.listOrdersForStatuses(FEEDBACK_MATCH_STATUSES);
    const normalizedToken = normalizeFeedbackTokenValue(token);
    return orders
      .filter((order) => {
        const feedbackMeta = getFeedbackMeta(order);
        return (
          feedbackMeta.state === 'waiting_for_feedback' &&
          isFeedbackSelfTestOrder(order) &&
          normalizeFeedbackTokenValue(feedbackMeta.token) === normalizedToken
        );
      })
      .sort(compareOrdersByRecency);
  }

  async runOrderFollowups({ now = new Date(), backfillOnly = false } = {}) {
    const summary = {
      backfilled: 0,
      remindersSent: 0,
      autoCancelled: 0,
      ambiguous: 0,
      deferredReplies: 0,
      skipped: 0,
      errors: 0
    };

    // Open orders are always checked. Closed orders (the long history) only if created in the last 45 days: older
    // ones can no longer need a reminder, a backfill or a reply, and reading ~1,900 of them every hour is slow.
    const closedStatuses = [...FOLLOWUP_CLOSED_STATUSES];
    // A WooCommerce hiccup (timeout, 5xx) is retried a few times instead of skipping the whole hour.
    const orders = [
      ...await this.withTransientRetry(() => this.listOrdersForStatuses(RECONCILIATION_STATUSES.filter((status) => !closedStatuses.includes(status))), 'open order list'),
      ...await this.withTransientRetry(() => this.listOrdersForStatuses(closedStatuses, { after: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString() }), 'closed order list')
    ];

    for (let index = 0; index < orders.length; index += 1) {
      const order = orders[index];
      // A HighDelivery send that died half way (restart while "sending") becomes "unknown" and the team hears once.
      if (this.hdAutoSend?.reviewStuckSend && getHdAutoSendState(order) === HD_STATE.sending) {
        try {
          await this.hdAutoSend.reviewStuckSend(order, now);
        } catch (error) {
          this.logger.warn(`[task][order-followups] stuck HighDelivery send check failed orderId=${String(order.id)}: ${error.message}`);
        }
      }
      if (!hasAmbiguousCustomerOutboundState(order, now)) {
        continue;
      }
      const normalizedOrder = normalizeWooOrder(order, this.messages);
      this.logger.warn(`[task][order-followups] ambiguous_send_state orderId=${normalizedOrder.orderId}`);
      this.store.upsertOrder({
        ...normalizedOrder,
        rawOrder: order,
        lastError: 'ambiguous_send_state'
      });
      summary.ambiguous += 1;
      // A WhatsApp send that never got an answer, more than 2 hours ago: counted as sent (never resent), the team is
      // told once, and the reminders / auto-cancel go on from there.
      try {
        const closed = await this.closeStaleReservations(order, now);
        if (closed) {
          orders[index] = closed;
        }
      } catch (error) {
        this.logger.warn(`[task][order-followups] could not close a stale send orderId=${normalizedOrder.orderId}: ${error.message}`);
      }
    }

    for (const listedOrder of orders) {
      const orderId = String(listedOrder.id);

      try {
        const action = await this.withOrderLock(orderId, async () => {
          let order = listedOrder;
          let workflow = getWorkflowMeta(order);
          let decisionMeta = getDecisionMeta(order);
          let localOrder = this.store.getOrder(orderId);
          // The list was read once at the start and this loop can take minutes: before anything is sent or written,
          // the order is read again (inside the lock) and the step is skipped when it changed in the meantime.
          let verified = false;
          const stillSame = async () => {
            if (verified) {
              return true;
            }
            const fresh = await this.rereadForFollowup(orderId, listedOrder);
            if (!fresh) {
              this.logFollowupDecision({ orderId, orderStatus: order.status, workflowState: workflow.state, confirmationSentAt: workflow.confirmationSentAt, reminderCount: workflow.reminderCount, action: 'skip_reread_failed' });
              return false;
            }
            if (followupSignature(fresh) !== followupSignature(listedOrder)) {
              this.logFollowupDecision({ orderId, orderStatus: fresh.status, workflowState: getWorkflowMeta(fresh).state, confirmationSentAt: getWorkflowMeta(fresh).confirmationSentAt, reminderCount: getWorkflowMeta(fresh).reminderCount, action: 'skip_changed_since_listing' });
              return false;
            }
            order = fresh;
            workflow = getWorkflowMeta(order);
            decisionMeta = getDecisionMeta(order);
            localOrder = this.store.getOrder(orderId);
            verified = true;
            return true;
          };

          if (hasAmbiguousCustomerOutboundState(order, now)) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_ambiguous_send_state'
            });
            return 'skipped';
          }

          const effectiveDecision = decisionMeta.decision || localOrder?.decision || '';
          const manualOverride = decisionMeta.manualOverride || localOrder?.manualOverride || '';
          if (manualOverride === 'yes') {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_manual_override'
            });
            return 'skipped';
          }

          if (effectiveDecision) {
            const targetWooStatus = effectiveDecision === DECISION.confirmed ? this.wooStatuses.confirmed : WOO_STATUS.cancelled;
            const currentSyncStatus = decisionMeta.wooSyncStatus || localOrder?.wooSyncStatus || '';
            // Internal alerts are sent once, when the customer decides (reply path). Never from here:
            // old orders (auto-cancelled, invalid phone, pre-flag) have no notified flag and would be re-alerted.
            const nextOrderState = {
              ...localOrder,
              ...normalizeWooOrder(order, this.messages),
              rawOrder: order,
              decision: effectiveDecision,
              decisionAt: decisionMeta.decisionAt || localOrder?.decisionAt || ''
            };
            if (currentSyncStatus === WOO_SYNC_STATUS.manual) {
              return 'skipped';
            }

            // A "thank you / cancelled" reply that was held back by the quiet hours goes out now.
            const replyKey = effectiveDecision === DECISION.confirmed ? OUTBOUND_LOGICAL_KEYS.confirmationSuccess : OUTBOUND_LOGICAL_KEYS.cancellationSuccess;
            if (isExpectedStatusForDecision(order.status, effectiveDecision, this.wooStatuses)
              && getOutboundReservationMeta(order, replyKey).state === SEND_STATE.deferred
              && await stillSame()
              && await this.sendDeferredDecisionReply({ order, nextOrderState: { ...nextOrderState, rawOrder: order }, decisionMeta, effectiveDecision, now })) {
              summary.deferredReplies += 1;
            }

            // markManualOverride reads the order again itself before writing anything.
            if (!isExpectedStatusForDecision(order.status, effectiveDecision, this.wooStatuses) && currentSyncStatus !== WOO_SYNC_STATUS.pendingRetry) {
              await this.markManualOverride({
                order: { ...nextOrderState, rawOrder: order },
                status: order.status
              });
              return 'skipped';
            }

            // Status and decision writes are absolute values (repeating them is harmless) and send nothing: no re-read.
            if (currentSyncStatus === WOO_SYNC_STATUS.pendingRetry) {
              const reconciliation = await this.reconcileWooDecision({
                order: { ...nextOrderState, rawOrder: order },
                targetState: effectiveDecision,
                targetWooStatus,
                note: effectiveDecision === DECISION.confirmed
                  ? 'Customer confirmed order via WhatsApp.'
                  : 'Customer cancelled order via WhatsApp.',
                nowIso: decisionMeta.decisionAt || localOrder?.decisionAt || now.toISOString()
              });
              if (reconciliation.success && effectiveDecision === DECISION.confirmed) {
                // The first status write failed, so the HighDelivery auto-send never ran: it runs now.
                await this.maybeRetryHdAutoSend(reconciliation.rawOrder || order, now);
              }
              return reconciliation.success ? 'skipped' : 'error';
            }

            if (effectiveDecision === DECISION.confirmed && currentSyncStatus === WOO_SYNC_STATUS.synced) {
              await this.maybeRetryHdAutoSend(order, now);
            }

            return 'skipped';
          }

          if (!ACTIVE_CONFIRMATION_STATUSES.includes(String(order.status || ''))) {
            if (workflow.confirmationSentAt && decisionMeta.manualOverride !== 'yes') {
              await this.markManualOverride({
                order: {
                  ...localOrder,
                  ...normalizeWooOrder(order, this.messages),
                  rawOrder: order
                },
                status: order.status
              });
              const updatedLocalOrder = this.store.getOrder(String(order.id));
              if (updatedLocalOrder) {
                this.logFollowupDecision({
                  orderId,
                  orderStatus: order.status,
                  workflowState: workflow.state,
                  confirmationSentAt: workflow.confirmationSentAt,
                  reminderCount: workflow.reminderCount,
                  action: 'skip_not_active'
                });
                return 'skipped';
              }
            }
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_not_active'
            });
            return 'skipped';
          }

          if (!workflow.confirmationSentAt) {
            if (isFeedbackSelfTestOrder(order)) {
              const feedbackMeta = getFeedbackMeta(order);
              this.logger.log(
                `[confirmation] skipped self-test confirmation backfill orderId=${String(order.id)} testPhone=${maskPhone(feedbackMeta.testPhone)} token=${feedbackMeta.token || ''} runId=${feedbackMeta.testRunId || ''}`
              );
              return 'skipped';
            }

            // Never first-contact a customer about an old order (abandoned checkouts, pre-service orders).
            if (isOrderOlderThan(order, now, BACKFILL_MAX_ORDER_AGE_MS)) {
              this.logFollowupDecision({
                orderId,
                orderStatus: order.status,
                workflowState: workflow.state,
                confirmationSentAt: workflow.confirmationSentAt,
                reminderCount: workflow.reminderCount,
                action: 'skip_backfill_too_old'
              });
              return 'skipped';
            }

            // The 30-second timer of the webhook owns this first message: never send it from here as well.
            if (this.pendingInitialConfirmations.has(orderId)) {
              this.logFollowupDecision({ orderId, orderStatus: order.status, workflowState: workflow.state, confirmationSentAt: workflow.confirmationSentAt, reminderCount: workflow.reminderCount, action: 'skip_confirmation_scheduled' });
              return 'skipped';
            }
            if (!await stillSame()) {
              return 'skipped';
            }
            if (workflow.confirmationSentAt || isConfirmationAlreadyStarted(workflow, this.store.getOrder(orderId))) {
              this.logFollowupDecision({ orderId, orderStatus: order.status, workflowState: workflow.state, confirmationSentAt: workflow.confirmationSentAt, reminderCount: workflow.reminderCount, action: 'skip_already_started' });
              return 'skipped';
            }

            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'backfill_initial'
            });
            const result = await this.sendInitialConfirmation(order, {
              note: 'WhatsApp confirmation backfill sent.',
              now
            });
            return result.body.ok ? 'backfilled' : 'error';
          }

          if (backfillOnly) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_not_due'
            });
            return 'skipped';
          }

          if (workflow.state === WORKFLOW_STATE.confirmed || workflow.state === WORKFLOW_STATE.cancelled) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_final_state'
            });
            return 'skipped';
          }

          const confirmationSentAt = new Date(workflow.confirmationSentAt);
          if (Number.isNaN(confirmationSentAt.getTime())) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_invalid_timestamp'
            });
            return 'skipped';
          }

          const ageMs = now.getTime() - confirmationSentAt.getTime();

          if (ageMs >= SECOND_REMINDER_MS && workflow.reminderCount === 1) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              ageMs,
              action: 'send_reminder_2'
            });
            if (!await stillSame()) {
              return 'skipped';
            }
            return await this.sendReminder(order, 2, now) ? 'reminderSent' : 'skipped';
          }

          if (ageMs >= FIRST_REMINDER_MS && workflow.reminderCount === 0) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              ageMs,
              action: 'send_reminder_1'
            });
            if (!await stillSame()) {
              return 'skipped';
            }
            return await this.sendReminder(order, 1, now) ? 'reminderSent' : 'skipped';
          }

          if (workflow.reminderCount >= 2) {
            const reminder2SentAt = new Date(workflow.reminder2SentAt || '');
            if (Number.isNaN(reminder2SentAt.getTime())) {
              this.logFollowupDecision({
                orderId,
                orderStatus: order.status,
                workflowState: workflow.state,
                confirmationSentAt: workflow.confirmationSentAt,
                reminderCount: workflow.reminderCount,
                action: 'skip_invalid_timestamp'
              });
              return 'skipped';
            }

            const afterSecondReminderMs = now.getTime() - reminder2SentAt.getTime();
            if (afterSecondReminderMs >= AUTO_CANCEL_AFTER_SECOND_REMINDER_MS) {
              this.logFollowupDecision({
                orderId,
                orderStatus: order.status,
                workflowState: workflow.state,
                confirmationSentAt: workflow.confirmationSentAt,
                reminderCount: workflow.reminderCount,
                ageMs: afterSecondReminderMs,
                action: 'auto_cancel'
              });
              if (!await stillSame()) {
                return 'skipped';
              }
              await this.autoCancelPendingOrder(order, now);
              return 'autoCancelled';
            }
          }

          this.logFollowupDecision({
            orderId,
            orderStatus: order.status,
            workflowState: workflow.state,
            confirmationSentAt: workflow.confirmationSentAt,
            reminderCount: workflow.reminderCount,
            ageMs,
            action: 'skip_not_due'
          });
          return 'skipped';
        });

        if (action === 'backfilled') {
          summary.backfilled += 1;
        } else if (action === 'reminderSent') {
          summary.remindersSent += 1;
        } else if (action === 'autoCancelled') {
          summary.autoCancelled += 1;
        } else if (action === 'error') {
          summary.errors += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        this.logger.error(error);
        summary.errors += 1;
      }
    }

    return summary;
  }

  logFollowupDecision({ orderId, orderStatus, workflowState, confirmationSentAt, reminderCount, ageMs = null, action }) {
    const ageHours = Number.isFinite(ageMs) ? (ageMs / (60 * 60 * 1000)).toFixed(2) : 'n/a';
    this.logger.log(
      `[task][order-followups] orderId=${orderId} status=${String(orderStatus || '')} workflowState=${String(workflowState || '')} confirmationSentAt=${String(confirmationSentAt || '')} reminderCount=${Number(reminderCount || 0)} ageHours=${ageHours} action=${action}`
    );
  }

  // Retries a WooCommerce read that failed for a passing reason (timeout, network, 429, 5xx); anything else is thrown.
  async withTransientRetry(work, label, attempts = 3) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= attempts || !isTransientWooError(error)) {
          throw error;
        }
        this.logger.warn(`[woo] ${label} failed (${error.message}); retry ${attempt + 1} of ${attempts}`);
        await this.sleep(2000 * attempt);
      }
    }
  }

  // The order as WooCommerce has it now, or null when it cannot be read (the step is then skipped this hour).
  async rereadForFollowup(orderId, listedOrder) {
    if (typeof this.wooClient.getOrder !== 'function') {
      return listedOrder;
    }
    try {
      return (await this.withTransientRetry(() => this.wooClient.getOrder(orderId), `order ${orderId}`)) || null;
    } catch (error) {
      this.logger.warn(`[task][order-followups] could not re-read orderId=${orderId}: ${error.message}`);
      return null;
    }
  }

  // Customer WhatsApp sends still "reserved" more than 2 hours after the attempt (the provider never answered). The
  // message may well have gone out, so it is never sent again: the reservation is closed as sent, at the reservation
  // time, so reminders and the auto-cancel continue from there. The team gets one alert (the state changes, so the
  // next run does not see it again). Returns the updated order, or null when nothing was changed.
  async closeStaleReservations(listedOrder, now = new Date()) {
    const orderId = String(listedOrder.id);
    return this.withOrderLock(orderId, async () => {
      const order = await this.rereadForFollowup(orderId, listedOrder);
      if (!order) {
        return null;
      }
      const stale = AMBIGUOUS_CHECK_KEYS.filter((logicalKey) => isStaleReservation(getOutboundReservationMeta(order, logicalKey), now));
      if (!stale.length) {
        return order;
      }
      const workflow = getWorkflowMeta(order);
      const updates = [];
      // A reservation whose send is known to have failed cleanly is simply cleared: the message is sent again later.
      const cleanFailures = stale.filter((logicalKey) => {
        const meta = getOutboundReservationMeta(order, logicalKey);
        return meta.failedFor && meta.failedFor === meta.reservedAt;
      });
      for (const logicalKey of cleanFailures) {
        updates.push(...buildLogicalSendMetaUpdate(order, logicalKey, { state: '', reservedAt: '' }));
      }
      const unanswered = stale.filter((logicalKey) => !cleanFailures.includes(logicalKey));
      if (!unanswered.length) {
        const cleared = await this.wooClient.updateOrderMeta(orderId, mergeMetaUpdates(updates));
        this.logger.warn(`[task][order-followups] failed_send_cleared orderId=${orderId} kinds=${cleanFailures.map((key) => key.replace('customer:', '')).join(', ')}`);
        return cleared && typeof cleared === 'object' && Array.isArray(cleared.meta_data) ? cleared : order;
      }
      for (const logicalKey of unanswered) {
        const meta = getOutboundReservationMeta(order, logicalKey);
        const at = meta.reservedAt;
        updates.push(...buildLogicalSendMetaUpdate(order, logicalKey, {
          state: SEND_STATE.sent,
          reservedAt: at,
          sentAt: meta.sentAt || at,
          messageId: meta.messageId || 'unconfirmed_timeout'
        }));
        if (logicalKey === OUTBOUND_LOGICAL_KEYS.confirmationRequest && !workflow.state) {
          updates.push(...buildWorkflowMetaUpdate(order, { state: WORKFLOW_STATE.pending, reminderCount: workflow.reminderCount || 0 }));
        }
        if (logicalKey === OUTBOUND_LOGICAL_KEYS.reminder1 && workflow.reminderCount < 1) {
          updates.push(...buildWorkflowMetaUpdate(order, { reminderCount: 1, lastReminderAt: at }));
        }
        if (logicalKey === OUTBOUND_LOGICAL_KEYS.reminder2 && workflow.reminderCount < 2) {
          updates.push(...buildWorkflowMetaUpdate(order, { reminderCount: 2, lastReminderAt: at }));
        }
      }
      const updated = await this.wooClient.updateOrderMeta(orderId, mergeMetaUpdates(updates));
      const kinds = unanswered.map((key) => key.replace('customer:', '')).join(', ');
      this.logger.warn(`[task][order-followups] stale_send_closed orderId=${orderId} kinds=${kinds}`);
      await this.safeAddOrderNote(orderId, `WhatsApp ${kinds}: no answer from the WhatsApp provider for more than 2 hours, so it may NOT have been sent. It is not sent again automatically; check the conversation.`);
      if (this.notifyTeam) {
        try {
          await this.notifyTeam(`ATTENTION: message WhatsApp peut-etre PAS envoye (pas de reponse du fournisseur), commande ${orderId}: ${kinds}. Pas renvoye automatiquement. Verifier la conversation.`);
        } catch (error) {
          this.logger.warn(`[task][order-followups] team alert failed orderId=${orderId}: ${error.message}`);
        }
      }
      return updated && typeof updated === 'object' && Array.isArray(updated.meta_data) ? updated : order;
    });
  }

  // A confirmed order whose HighDelivery auto-send never ran (its first status write failed, or the process stopped
  // first). Only when the HighDelivery state is empty and it was never retried: the retry mark is written before the
  // call, so this happens at most once per order, and the auto-send itself re-checks the state before sending.
  async maybeRetryHdAutoSend(order, now = new Date()) {
    if (!this.hdAutoSend?.enabled) {
      return false;
    }
    const orderId = String(order?.id ?? '');
    const decisionMeta = getDecisionMeta(order);
    const decidedMs = Date.parse(decisionMeta.decisionAt || '');
    if (!orderId
      || decisionMeta.decision !== DECISION.confirmed
      || getHdAutoSendState(order)
      || readOrderMeta(order, HD_RETRY_META)
      || HD_PARCEL_TRACE_META.some((key) => readOrderMeta(order, key))
      || Number(decisionMeta.wooSyncAttempts || 0) < 2
      || Number.isNaN(decidedMs)
      || now.getTime() - decidedMs > HD_RETRY_MAX_AGE_MS
      || !wooStatusMatchesTarget(order.status, this.wooStatuses.confirmed)) {
      return false;
    }
    // Any order note about HighDelivery (a held or skipped auto-send, a parcel made by hand) means a human or an
    // earlier run already dealt with it. Notes that cannot be read count as "maybe": no retry.
    if (await this.hasHighDeliveryNote(orderId)) {
      this.logger.log(`[hd-auto-send] retry skipped orderId=${orderId} reason=highdelivery_note_or_unreadable`);
      return false;
    }
    try {
      await this.wooClient.updateOrderMeta(orderId, [{ key: HD_RETRY_META, value: now.toISOString() }]);
    } catch (error) {
      this.logger.warn(`[hd-auto-send] could not mark the retry orderId=${orderId}: ${error.message}`);
      return false;
    }
    this.logger.log(`[hd-auto-send] retrying an auto-send that never ran orderId=${orderId}`);
    this.scheduleHdAutoSend({ ...normalizeWooOrder(order, this.messages), rawOrder: order });
    return true;
  }

  async hasHighDeliveryNote(orderId) {
    if (typeof this.wooClient.request !== 'function') {
      return true;
    }
    try {
      const notes = await this.wooClient.request(`/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}/notes`, { method: 'GET' });
      if (!Array.isArray(notes)) {
        return true;
      }
      return notes.some((note) => /high ?delivery/iu.test(String(note?.note || '')));
    } catch (error) {
      this.logger.warn(`[hd-auto-send] could not read the notes orderId=${orderId}: ${error.message}`);
      return true;
    }
  }

  pruneRecentInboundMessageKeys() {
    const cutoff = Date.now() - INBOUND_MESSAGE_DEDUPE_TTL_MS;
    for (const [messageKey, timestamp] of this.recentInboundMessageKeys.entries()) {
      if (timestamp < cutoff) {
        this.recentInboundMessageKeys.delete(messageKey);
      }
    }
  }

  async sendLogicalMessageWithWooReservation({
    orderPayload,
    orderId,
    phone,
    logicalKey,
    kind,
    message,
    persistAfterSend = null,
    now = new Date()
  }) {
    const outboundMeta = getOutboundReservationMeta(orderPayload, logicalKey);
    const nowIso = now.toISOString();
    const reservedAtMs = Date.parse(outboundMeta.reservedAt || '');

    if (outboundMeta.state === SEND_STATE.sent) {
      return { ok: true, duplicate: true, orderPayload };
    }

    // Quiet hours: nothing is reserved and nothing is sent. The hourly task tries again after the window.
    if (this.isQuietNow()) {
      this.logger.log(`[quiet-hours] deferred orderId=${orderId} logicalKey=${logicalKey}`);
      return { ok: true, duplicate: true, deferred: true, orderPayload };
    }

    if (outboundMeta.state === SEND_STATE.reserved) {
      if (!Number.isNaN(reservedAtMs) && (now.getTime() - reservedAtMs) < OUTBOUND_RESERVATION_STALE_MS) {
        return { ok: true, duplicate: true, inProgress: true, orderPayload };
      }

      this.logger.warn(
        `[outbound] ambiguous_send_state orderId=${orderId} logicalKey=${logicalKey} reservedAt=${outboundMeta.reservedAt || ''}`
      );
      return { ok: false, duplicate: true, ambiguous: true, orderPayload };
    }

    // Reserve, as a claim another instance can see: the order is read fresh first (a send another instance already
    // made or started is not made again), the reservation and the claim are written together, and after a short
    // wait the order is read back; only the instance whose claim is still there sends.
    const claimed = await claim(this.wooClient, orderId, outboundClaimKey(OUTBOUND_META_KEYS[logicalKey]), {
      ttlMs: OUTBOUND_RESERVATION_STALE_MS,
      state: SEND_STATE.reserved,
      settleMs: this.claimSettleMs,
      sleep: this.sleep,
      instanceId: this.instanceId,
      fallback: orderPayload,
      logger: this.logger,
      check: (fresh) => {
        const freshMeta = getOutboundReservationMeta(fresh, logicalKey);
        if (freshMeta.state === SEND_STATE.sent) {
          return 'sent';
        }
        if (freshMeta.state === SEND_STATE.reserved) {
          return isStaleReservation(freshMeta, now) ? 'ambiguous' : 'reserved';
        }
        return '';
      },
      extraMeta: buildLogicalSendMetaUpdate(orderPayload, logicalKey, {
        state: assertTransition(OUTBOUND_SEND, outboundMeta.state, SEND_STATE.reserved),
        reservedAt: nowIso
      })
    });
    if (!claimed.ok) {
      this.logger.warn(`[outbound] not sent here orderId=${orderId} logicalKey=${logicalKey} reason=${claimed.reason}`);
      if (claimed.reason === 'sent') {
        return { ok: true, duplicate: true, orderPayload };
      }
      if (claimed.reason === 'ambiguous') {
        return { ok: false, duplicate: true, ambiguous: true, orderPayload };
      }
      return { ok: true, duplicate: true, inProgress: true, claimedElsewhere: true, orderPayload };
    }
    const reservationOrder = claimed.written || orderPayload;

    let sendResult;
    try {
      sendResult = await this.wasenderClient.sendMessage({
        to: phone,
        message
      });
    } catch (error) {
      if (error?.ambiguous) {
        // No answer from the WhatsApp provider: the message may have gone out, so the reservation stays ("reserved")
        // and the order is flagged ambiguous for a human instead of being sent a second time.
        this.logger.warn(`[outbound] ambiguous_send_timeout orderId=${orderId} logicalKey=${logicalKey}`);
        return { ok: false, duplicate: true, ambiguous: true, orderPayload };
      }
      // A clean refusal: nothing went out. The reservation is cleared, and the failure is also recorded on its own
      // (the reservation time it belongs to), so a reservation left behind is never mistaken for a sent message.
      try {
        // The claim is released in the same write: the message may be sent again later, by any instance.
        await claimed.release(
          buildLogicalSendMetaUpdate(reservationOrder, logicalKey, {
            state: assertTransition(OUTBOUND_SEND, SEND_STATE.reserved, SEND_STATE.none),
            reservedAt: '',
            failedFor: nowIso
          })
        );
      } catch (clearError) {
        this.logger.warn(`[outbound] unable to clear failed reservation orderId=${orderId} logicalKey=${logicalKey} error=${clearError.message}`);
        try {
          await this.wooClient.updateOrderMeta(orderId, buildLogicalSendMetaUpdate(reservationOrder, logicalKey, { failedFor: nowIso }));
        } catch (markError) {
          this.logger.warn(`[outbound] unable to record the failed send orderId=${orderId} logicalKey=${logicalKey} error=${markError.message}`);
        }
      }
      throw error;
    }

    const acceptedAt = new Date().toISOString();
    const providerMessageId = extractMessageId(sendResult) || '';
    this.store.appendMessage({
      source: 'outbound',
      orderId,
      phone,
      kind,
      payload: sendResult,
      text: message
    });

    if (persistAfterSend) {
      try {
        const persistResult = await persistAfterSend({
          acceptedAt,
          providerMessageId,
          sendResult,
          reservedAt: nowIso,
          reservationOrder
        });
        return {
          ok: true,
          duplicate: false,
          persisted: true,
          acceptedAt,
          providerMessageId,
          sendResult,
          persistResult
        };
      } catch (error) {
        this.logger.warn(
          `[outbound] accepted_not_persisted orderId=${orderId} logicalKey=${logicalKey} error=${error.message}`
        );
        return {
          ok: true,
          duplicate: false,
          persisted: false,
          ambiguous: true,
          acceptedAt,
          providerMessageId,
          sendResult,
          error
        };
      }
    }

    try {
      await this.wooClient.updateOrderMeta(
        orderId,
        buildLogicalSendMetaUpdate(reservationOrder, logicalKey, {
          state: SEND_STATE.sent,
          reservedAt: nowIso,
          sentAt: acceptedAt,
          messageId: providerMessageId
        })
      );
      return {
        ok: true,
        duplicate: false,
        persisted: true,
        acceptedAt,
        providerMessageId,
        sendResult
      };
    } catch (error) {
      this.logger.warn(
        `[outbound] accepted_not_persisted orderId=${orderId} logicalKey=${logicalKey} error=${error.message}`
      );
      return {
        ok: true,
        duplicate: false,
        persisted: false,
        ambiguous: true,
        acceptedAt,
        providerMessageId,
        sendResult,
        error
      };
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

  async persistReminderMeta({ orderPayload, normalizedOrder, reminderCount, acceptedAt, providerMessageId, reservedAt }) {
    const decisionMeta = getDecisionMeta(orderPayload);
    const logicalKey = reminderCount === 1
      ? OUTBOUND_LOGICAL_KEYS.reminder1
      : OUTBOUND_LOGICAL_KEYS.reminder2;
    const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
      normalizedOrder.orderId,
      mergeMetaUpdates(
        buildWorkflowMetaUpdate(orderPayload, {
          state: WORKFLOW_STATE.pending,
          reminderCount,
          lastReminderAt: acceptedAt,
          reminder1SentAt: reminderCount === 1 ? acceptedAt : undefined,
          reminder1MessageId: reminderCount === 1 ? (providerMessageId || '') : undefined,
          reminder2SentAt: reminderCount === 2 ? acceptedAt : undefined,
          reminder2MessageId: reminderCount === 2 ? (providerMessageId || '') : undefined
        }),
        buildDecisionMetaUpdate(orderPayload, {
          invalidReplyCount: decisionMeta.invalidReplyCount,
          manualFollowupRequired: decisionMeta.manualFollowupRequired || 'no',
          lastConfirmationMessageKey: decisionMeta.lastConfirmationMessageKey || ''
        }),
        buildLogicalSendMetaUpdate(orderPayload, logicalKey, {
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
      reminderCount,
      lastReminderAt: acceptedAt,
      invalidReplyCount: decisionMeta.invalidReplyCount,
      manualFollowupRequired: decisionMeta.manualFollowupRequired === 'yes'
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

  async listOrdersForApi({ status } = {}) {
    const orders = await this.buildApiOrdersReadModel();
    if (!status) {
      return orders;
    }

    return orders.filter((order) => order.status === status);
  }

  async getOrdersSummaryForApi() {
    const orders = await this.buildApiOrdersReadModel();
    const byStage = {};

    for (const order of orders) {
      byStage[order.status] = (byStage[order.status] || 0) + 1;
    }

    return {
      total: orders.length,
      byStage
    };
  }

  async buildApiOrdersReadModel() {
    const liveOrders = await this.listOrdersForStatuses(RECONCILIATION_STATUSES);
    const localOrders = this.store.listOrders();
    const localOrdersById = new Map(localOrders.map((order) => [order.orderId, order]));
    const mergedOrders = new Map();

    for (const liveOrder of liveOrders) {
      const orderId = String(liveOrder.id);
      const localOrder = localOrdersById.get(orderId) || null;
      const apiOrder = buildApiOrder({
        liveOrder,
        localOrder,
        messages: this.messages
      });

      if (apiOrder) {
        mergedOrders.set(orderId, apiOrder);
      }
    }

    for (const localOrder of localOrders) {
      if (mergedOrders.has(localOrder.orderId)) {
        continue;
      }

      if (!isLocalOnlyApiStatus(localOrder.confirmationState)) {
        continue;
      }

      const apiOrder = buildApiOrder({
        liveOrder: null,
        localOrder,
        messages: this.messages
      });
      if (apiOrder) {
        mergedOrders.set(localOrder.orderId, apiOrder);
      }
    }

    return [...mergedOrders.values()].sort(compareApiOrdersByRecency);
  }

  async resolveReplyContext(phone, { allowWooRecovery = true } = {}) {
    const localPendingOrders = this.store.listPendingOrdersByPhone(phone).sort(compareOrdersByRecency);
    const localPendingOrder = localPendingOrders[0] || null;
    const localLatestOrder = localPendingOrder || this.store.findLatestOrderByPhone(phone);
    if (localPendingOrders.length) {
      return {
        pendingOrders: localPendingOrders,
        pendingOrder: localPendingOrder,
        latestOrder: localLatestOrder,
        matchedViaWooFallback: false
      };
    }

    if (!allowWooRecovery) {
      return {
        pendingOrders: [],
        pendingOrder: null,
        latestOrder: localLatestOrder,
        matchedViaWooFallback: false
      };
    }

    const recoveredOrders = await this.findPendingWooOrdersByPhone(phone);
    if (!recoveredOrders.length) {
      return {
        pendingOrders: [],
        pendingOrder: null,
        latestOrder: localLatestOrder,
        matchedViaWooFallback: false
      };
    }

    const storedRecoveredOrders = recoveredOrders.map((recoveredOrder) => this.store.upsertOrder({
      ...normalizeWooOrder(recoveredOrder, this.messages),
      rawOrder: recoveredOrder,
      confirmationState: 'pending_confirmation',
      invalidReplyCount: getDecisionMeta(recoveredOrder).invalidReplyCount,
      manualFollowupRequired: getDecisionMeta(recoveredOrder).manualFollowupRequired === 'yes',
      lastConfirmationMessageKey: getDecisionMeta(recoveredOrder).lastConfirmationMessageKey || ''
    }));
    const storedRecoveredOrder = storedRecoveredOrders[0];

    return {
      pendingOrders: storedRecoveredOrders,
      pendingOrder: storedRecoveredOrder,
      latestOrder: storedRecoveredOrder,
      matchedViaWooFallback: true
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

  async sendReminder(orderPayload, reminderCount, now) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const message = interpolateTemplate(this.messages.reminderMessage, buildTemplateValues(normalizedOrder));
    const logicalKey = reminderCount === 1
      ? OUTBOUND_LOGICAL_KEYS.reminder1
      : OUTBOUND_LOGICAL_KEYS.reminder2;
    const sendOutcome = await this.sendLogicalMessageWithWooReservation({
      orderPayload,
      orderId: normalizedOrder.orderId,
      phone: normalizedOrder.phone,
      logicalKey,
      kind: `reminder_${reminderCount}`,
      message,
      now,
      persistAfterSend: async ({ acceptedAt, providerMessageId, reservedAt }) => {
        const persistedOrder = await this.persistReminderMeta({
          orderPayload,
          normalizedOrder,
          reminderCount,
          acceptedAt: acceptedAt || now.toISOString(),
          providerMessageId,
          reservedAt
        });
        await this.safeAddOrderNote(normalizedOrder.orderId, `WhatsApp reminder #${reminderCount} sent.`);
        return persistedOrder;
      }
    });

    if (sendOutcome.inProgress || sendOutcome.duplicate) {
      return false;
    }

    if (!sendOutcome.persisted) {
      const decisionMeta = getDecisionMeta(orderPayload);
      this.store.upsertOrder({
        ...normalizedOrder,
        rawOrder: orderPayload,
        confirmationState: 'pending_confirmation',
        reminderCount,
        lastReminderAt: sendOutcome.acceptedAt || now.toISOString(),
        invalidReplyCount: decisionMeta.invalidReplyCount,
        manualFollowupRequired: decisionMeta.manualFollowupRequired === 'yes',
        lastError: sendOutcome.ambiguous ? 'ambiguous_send_state' : ''
      });
    }

    return sendOutcome.persisted === true;
  }

  async autoCancelPendingOrder(orderPayload, now) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const nowIso = now.toISOString();
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
          customerReplySent: 'no'
        })
      )
    );
    await this.safeAddOrderNote(normalizedOrder.orderId, 'Order auto-cancelled 24h after the second WhatsApp reminder without confirmation.');
    const sendOutcome = await this.sendLogicalMessageWithWooReservation({
      orderPayload: metaUpdatedOrder || statusUpdatedOrder || orderPayload,
      phone: normalizedOrder.phone,
      orderId: normalizedOrder.orderId,
      logicalKey: OUTBOUND_LOGICAL_KEYS.autoCancellation,
      kind: 'auto_cancellation',
      message: this.messages.cancelledReply,
      now,
      persistAfterSend: async ({ providerMessageId, reservedAt, reservationOrder }) => {
        return this.wooClient.updateOrderMeta(
          normalizedOrder.orderId,
          buildLogicalSendMetaUpdate(reservationOrder || metaUpdatedOrder || statusUpdatedOrder || orderPayload, OUTBOUND_LOGICAL_KEYS.autoCancellation, {
            state: SEND_STATE.sent,
            reservedAt,
            messageId: providerMessageId
          })
        );
      }
    });
    this.store.upsertOrder({
      ...normalizedOrder,
      rawOrder: sendOutcome.persistResult || metaUpdatedOrder || statusUpdatedOrder || orderPayload,
      confirmationState: 'cancelled',
      wooStatus: WOO_STATUS.cancelled,
      finalReply: 'timeout',
      decision: DECISION.cancelled,
      decisionAt: nowIso,
      lastError: sendOutcome.ambiguous ? 'ambiguous_send_state' : ''
    });
  }

  async cancelOrderForUnreachableWhatsApp(orderPayload, error, now = new Date()) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    return this.cancelOrderWithReason({
      orderPayload,
      now,
      cancellationReason: 'invalid_or_non_whatsapp_number',
      logLabel: 'unreachable whatsapp',
      noteBuilder: buildUnreachableWhatsAppCancellationNote,
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

  async safeSendTrackedMessage({ phone, orderId, kind, message }) {
    if (this.isQuietNow()) {
      this.logger.log(`[quiet-hours] skipped orderId=${orderId} kind=${kind}`);
      return null;
    }
    try {
      const result = await this.wasenderClient.sendMessage({
        to: phone,
        message
      });
      this.store.appendMessage({
        source: 'outbound',
        orderId,
        phone,
        kind,
        payload: result,
        text: message
      });
      return result;
    } catch (error) {
      this.logger.warn(`Unable to send WhatsApp follow-up for order ${orderId}: ${error.message}`);
      return null;
    }
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
    const task = Promise.resolve()
      .then(() => this.hdAutoSend.autoSend(order))
      .catch((error) => this.logger.warn(`[hd-auto-send] unexpected failure orderId=${order?.orderId}: ${error.message}`))
      .finally(() => this.backgroundTasks.delete(task));
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
    const candidateOrders = await this.listOrdersForStatuses(REPLY_RECOVERY_STATUSES);

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

const HD_RETRY_META = HD_META.retryAt;
const HD_STATE_META = HD_META.state;
const HD_RETRY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const AMBIGUOUS_CHECK_KEYS = [
  OUTBOUND_LOGICAL_KEYS.confirmationRequest,
  OUTBOUND_LOGICAL_KEYS.reminder1,
  OUTBOUND_LOGICAL_KEYS.reminder2,
  OUTBOUND_LOGICAL_KEYS.confirmationSuccess,
  OUTBOUND_LOGICAL_KEYS.cancellationSuccess,
  OUTBOUND_LOGICAL_KEYS.autoCancellation
];

function readOrderMeta(order, key) {
  const row = (Array.isArray(order?.meta_data) ? order.meta_data : []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

function getHdAutoSendState(order) {
  return readOrderMeta(order, HD_STATE_META);
}

function isStaleReservation(outboundMeta, now) {
  if (outboundMeta.state !== SEND_STATE.reserved) {
    return false;
  }
  const reservedAtMs = Date.parse(outboundMeta.reservedAt || '');
  return !Number.isNaN(reservedAtMs) && (now.getTime() - reservedAtMs) >= OUTBOUND_RESERVATION_STALE_MS;
}

// What the hourly task decided on: if any of it changed between the listing and the action, the action is skipped.
function followupSignature(order) {
  const decision = getDecisionMeta(order);
  return JSON.stringify([
    String(order?.status || ''),
    getWorkflowMeta(order),
    decision.decision,
    decision.wooSyncStatus,
    decision.customerReplySent,
    decision.manualOverride,
    decision.lastConfirmationMessageKey,
    Object.keys(OUTBOUND_META_KEYS).map((logicalKey) => getOutboundReservationMeta(order, logicalKey).state)
  ]);
}

// A WooCommerce error worth retrying: no answer, a timeout, 429 or a 5xx. A 4xx is an answer and is not retried.
function isTransientWooError(error) {
  const message = String(error?.message || '');
  const status = message.match(/failed with (\d{3})/u);
  if (status) {
    const code = Number(status[1]);
    return code === 429 || code >= 500;
  }
  return ['TimeoutError', 'AbortError'].includes(error?.name) || /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket|terminated|timed? ?out/iu.test(message);
}

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

function buildApiOrder({ liveOrder, localOrder, messages }) {
  const sourceOrder = liveOrder || localOrder?.rawOrder || {};
  const normalizedOrder = liveOrder
    ? normalizeWooOrder(liveOrder, messages)
    : {
        orderId: String(localOrder?.orderId || ''),
        phone: localOrder?.phone || '',
        customerEmail: localOrder?.customerEmail || '',
        customerName: localOrder?.customerName || '',
        total: localOrder?.total || '',
        currency: localOrder?.currency || '',
        deliveryAddress: localOrder?.deliveryAddress || 'Ma kaynach',
        deliveryCity: localOrder?.deliveryCity || messages.defaultCityLabel,
        deliveryEta: localOrder?.deliveryEta || resolveDeliveryEta(localOrder?.deliveryCity || '', messages),
        lineItems: Array.isArray(localOrder?.lineItems) ? localOrder.lineItems : [],
        orderItemsSummary: localOrder?.orderItemsSummary || '',
        wooStatus: localOrder?.wooStatus || 'pending'
      };
  const workflow = getWorkflowMeta(sourceOrder);
  const decisionMeta = getDecisionMeta(sourceOrder);
  const workflowView = mergeWorkflowView({ workflow, decisionMeta, localOrder });
  const status = deriveApiStatus({
    workflow: workflowView,
    decision: workflowView,
    localOrder
  });

  if (!status) {
    return null;
  }

  return {
    orderId: normalizedOrder.orderId,
    phone: normalizedOrder.phone,
    customerName: normalizedOrder.customerName,
    total: normalizedOrder.total,
    currency: normalizedOrder.currency,
    deliveryAddress: normalizedOrder.deliveryAddress,
    deliveryCity: normalizedOrder.deliveryCity,
    deliveryEta: normalizedOrder.deliveryEta,
    lineItems: normalizedOrder.lineItems,
    orderItemsSummary: normalizedOrder.orderItemsSummary,
    wooStatus: liveOrder?.status || normalizedOrder.wooStatus || localOrder?.wooStatus || '',
    status,
    workflowState: workflowView.state,
    confirmationSentAt: workflowView.confirmationSentAt,
    reminderCount: workflowView.reminderCount,
    lastReminderAt: workflowView.lastReminderAt,
    cancelledAt: workflowView.cancelledAt,
    decision: workflowView.decision,
    decisionAt: workflowView.decisionAt,
    wooSyncStatus: workflowView.wooSyncStatus,
    wooSyncAttempts: workflowView.wooSyncAttempts,
    lastSyncError: workflowView.lastSyncError,
    customerReplySent: workflowView.customerReplySent,
    cancellationReason: workflowView.cancellationReason,
    manualOverride: workflowView.manualOverride,
    manualOverrideAt: workflowView.manualOverrideAt,
    manualOverrideStatus: workflowView.manualOverrideStatus,
    invalidReplyCount: workflowView.invalidReplyCount,
    manualFollowupRequired: workflowView.manualFollowupRequired,
    customerEmail: normalizedOrder.customerEmail || '',
    customerEmailStatus: localOrder?.customerEmailStatus || '',
    customerEmailError: localOrder?.customerEmailError || '',
    lastError: localOrder?.lastError || '',
    updatedAt: localOrder?.updatedAt || ''
  };
}

function mergeWorkflowView({ workflow, decisionMeta, localOrder }) {
  return {
    state: workflow.state || String(localOrder?.workflowState || ''),
    confirmationSentAt: workflow.confirmationSentAt || String(localOrder?.confirmationSentAt || ''),
    reminderCount: workflow.confirmationSentAt
      ? workflow.reminderCount
      : Number(localOrder?.reminderCount || 0),
    lastReminderAt: workflow.lastReminderAt || String(localOrder?.lastReminderAt || ''),
    cancelledAt: workflow.cancelledAt || String(localOrder?.cancelledAt || ''),
    decision: decisionMeta.decision || String(localOrder?.decision || ''),
    decisionAt: decisionMeta.decisionAt || String(localOrder?.decisionAt || ''),
    wooSyncStatus: decisionMeta.wooSyncStatus || String(localOrder?.wooSyncStatus || ''),
    wooSyncAttempts: hasDecisionMetaValue(decisionMeta.wooSyncAttempts)
      ? decisionMeta.wooSyncAttempts
      : Number(localOrder?.wooSyncAttempts || 0),
    lastSyncError: decisionMeta.lastSyncError || String(localOrder?.lastSyncError || ''),
    customerReplySent: decisionMeta.customerReplySent || String(localOrder?.customerReplySent || ''),
    cancellationReason: decisionMeta.cancellationReason || String(localOrder?.cancellationReason || ''),
    manualOverride: decisionMeta.manualOverride || String(localOrder?.manualOverride || ''),
    manualOverrideAt: decisionMeta.manualOverrideAt || String(localOrder?.manualOverrideAt || ''),
    manualOverrideStatus: decisionMeta.manualOverrideStatus || String(localOrder?.manualOverrideStatus || ''),
    invalidReplyCount: hasDecisionMetaValue(decisionMeta.invalidReplyCount)
      ? decisionMeta.invalidReplyCount
      : Number(localOrder?.invalidReplyCount || 0),
    manualFollowupRequired: decisionMeta.manualFollowupRequired
      ? decisionMeta.manualFollowupRequired === 'yes'
      : Boolean(localOrder?.manualFollowupRequired)
  };
}

function deriveApiStatus({ workflow, decision, localOrder }) {
  if (decision.manualOverride === 'yes' || decision.wooSyncStatus === WOO_SYNC_STATUS.manual) {
    return 'manual';
  }

  if (decision.decision === DECISION.confirmed) {
    return 'confirmed';
  }

  if (decision.decision === DECISION.cancelled || workflow.state === WORKFLOW_STATE.cancelled) {
    return 'cancelled';
  }

  if (workflow.confirmationSentAt) {
    if (workflow.reminderCount >= 2) {
      return 'second_reminder_sent';
    }
    if (workflow.reminderCount === 1) {
      return 'first_reminder_sent';
    }
    return 'confirmation_sent';
  }

  if (localOrder?.confirmationState === 'send_failed') {
    return 'send_failed';
  }

  if (localOrder?.confirmationState === 'failed_missing_phone') {
    return 'failed_missing_phone';
  }

  return '';
}

function isLocalOnlyApiStatus(status) {
  return status === 'send_failed' || status === 'failed_missing_phone';
}

function hasDecisionMetaValue(value) {
  return value !== undefined && value !== null && value !== '';
}

const CONFIRMATION_POLL_OPTIONS = ['Confirmer', 'Annuler'];

const POLL_OPTION_REPLIES = [
  { pattern: /^confirm/iu, reply: '1' },
  { pattern: /^(annul|cancel)/iu, reply: '2' }
];

// A vote on our confirmation poll is the same decision as typing "1" or "2".
function extractPollVoteMessages(payload, eventKey, logger = console) {
  const pollKey = payload?.data?.key || {};
  if (pollKey.fromMe === false) {
    return [];
  }

  const pollId = String(pollKey.id || '').trim() || eventKey;
  const results = Array.isArray(payload?.data?.pollResult) ? payload.data.pollResult : [];
  const messages = [];

  for (const result of results) {
    const reply = POLL_OPTION_REPLIES.find(({ pattern }) => pattern.test(String(result?.name || '').trim()))?.reply;
    if (!reply) {
      continue;
    }

    for (const voter of Array.isArray(result.voters) ? result.voters : []) {
      const senderRaw = String(voter || '');
      const senderPhone = senderRaw.endsWith('@lid') ? '' : normalizePhone(normalizeRemoteJid(senderRaw));
      if (!senderPhone) {
        logger.warn(`[webhook][wasender] poll vote skipped, voter is not a phone jid domain=${senderRaw.split('@')[1] || 'none'} pollId=${pollId}`);
        continue;
      }

      const index = messages.length;
      const message = { key: { id: pollId, remoteJid: senderRaw }, poll: result.name, vote: reply };
      messages.push({
        webhookEventKey: eventKey,
        messageIndex: index,
        messageKey: `poll:${pollId}:${senderPhone}:${reply}`,
        providerMessageId: null,
        senderPhone,
        senderRaw,
        recipientRaw: '',
        timestamp: resolveInboundTimestamp(payload?.timestamp),
        kind: 'text',
        textBody: reply,
        captionText: '',
        mediaRef: '',
        mimeType: '',
        fromMe: false,
        rawMessage: message,
        rawEnvelopeSnapshot: {
          eventKey,
          index,
          topLevelKeys: Object.keys(payload || {}).sort(),
          dataKeys: Object.keys(payload?.data || {}).sort(),
          providerMessageId: '',
          message
        }
      });
    }
  }

  return messages;
}

function extractWasenderInboundMessages(payload, eventKey, logger = console) {
  if (payload?.event === 'poll.results') {
    return extractPollVoteMessages(payload, eventKey, logger);
  }

  const messages = extractWasenderMessages(payload, logger);

  return messages.map((message, index) => normalizeWasenderInboundMessage({
    payload,
    eventKey,
    message,
    index
  }));
}

function extractWasenderMessages(payload, logger = console) {
  const candidate = payload?.data?.messages;
  if (Array.isArray(candidate)) {
    return candidate;
  }
  if (candidate && typeof candidate === 'object') {
    return [candidate];
  }

  if (isLikelyWasenderMessageEnvelope(payload)) {
    return [payload];
  }

  logger.warn(`[webhook][wasender] unrecognized inbound payload shape topKeys=${JSON.stringify(Object.keys(payload || {}).sort())} dataKeys=${JSON.stringify(Object.keys(payload?.data || {}).sort())}`);
  return [];
}

function normalizeWasenderInboundMessage({ payload, eventKey, message, index }) {
  const messageKey = message?.key || {};
  const messageNode = message?.message || {};
  const media = extractInboundMediaFields(message, messageNode);
  const providerMessageId = String(
    message?.id ||
    messageKey?.id ||
    message?.messageId ||
    payload?.id ||
    ''
  ).trim();
  const rawTimestamp =
    message?.messageTimestamp ||
    message?.timestamp ||
    messageKey?.messageTimestamp ||
    payload?.timestamp ||
    payload?.data?.timestamp ||
    '';
  const timestamp = resolveInboundTimestamp(
    rawTimestamp
  );
  const textBody = extractInboundText(message, messageNode, payload);
  const captionText = extractInboundCaption(messageNode, media.node);
  const senderRaw =
    messageKey.cleanedSenderPn ||
    messageKey.senderPn ||
    normalizeRemoteJid(messageKey.remoteJid) ||
    payload?.from ||
    payload?.sender ||
    payload?.senderPhone ||
    payload?.phone ||
    payload?.data?.from ||
    payload?.data?.sender ||
    payload?.data?.senderPhone ||
    payload?.message?.from ||
    '';
  const recipientRaw =
    message?.to ||
    payload?.to ||
    payload?.recipient ||
    payload?.data?.to ||
    payload?.data?.recipient ||
    '';

  return {
    webhookEventKey: eventKey,
    messageIndex: index,
    messageKey: providerMessageId || buildCanonicalInboundMessageKey({
      senderPhone: normalizePhone(senderRaw),
      senderRaw,
      recipientRaw,
      rawTimestamp,
      kind: media.kind,
      textBody,
      captionText,
      mediaRef: media.mediaRef,
      mimeType: media.mimeType
    }),
    providerMessageId: providerMessageId || null,
    senderPhone: normalizePhone(senderRaw),
    senderRaw: String(senderRaw || ''),
    recipientRaw: String(recipientRaw || ''),
    timestamp,
    kind: media.kind,
    textBody,
    captionText,
    mediaRef: media.mediaRef,
    mimeType: media.mimeType,
    fromMe: Boolean(messageKey.fromMe || message?.fromMe),
    rawMessage: message,
    rawEnvelopeSnapshot: {
      eventKey,
      index,
      topLevelKeys: Object.keys(payload || {}).sort(),
      dataKeys: Object.keys(payload?.data || {}).sort(),
      providerMessageId: providerMessageId || '',
      message
    }
  };
}

function normalizeRemoteJid(remoteJid) {
  if (!remoteJid || typeof remoteJid !== 'string') {
    return '';
  }

  return remoteJid.split('@')[0];
}

function extractInboundText(message, messageNode, payload) {
  const candidateText =
    message?.messageBody ||
    messageNode?.conversation ||
    messageNode?.extendedTextMessage?.text ||
    payload?.text ||
    payload?.body ||
    payload?.data?.text ||
    payload?.data?.body ||
    payload?.message?.text;

  return typeof candidateText === 'string' ? candidateText : '';
}

function extractInboundCaption(messageNode, mediaNode) {
  const caption =
    mediaNode?.caption ||
    messageNode?.extendedTextMessage?.text ||
    '';

  return typeof caption === 'string' ? caption : '';
}

function extractInboundMediaFields(message, messageNode) {
  const mediaCandidates = [
    { kind: 'image', node: messageNode?.imageMessage },
    { kind: 'audio', node: messageNode?.audioMessage || (messageNode?.ptt ? { mimetype: '' } : null) || (message?.audio ? { ...message.audio, mimetype: message?.audio?.mimetype } : null) },
    { kind: 'video', node: messageNode?.videoMessage },
    { kind: 'document', node: messageNode?.documentMessage },
    { kind: 'sticker', node: messageNode?.stickerMessage }
  ];

  for (const candidate of mediaCandidates) {
    if (!candidate.node) {
      continue;
    }

    return {
      kind: candidate.kind,
      node: candidate.node,
      mediaRef: extractMediaReference(candidate.node),
      mimeType: String(candidate.node?.mimetype || candidate.node?.mimeType || '')
    };
  }

  return {
    kind: 'text',
    node: null,
    mediaRef: '',
    mimeType: ''
  };
}

function extractMediaReference(mediaNode) {
  const candidate = [
    mediaNode?.url,
    mediaNode?.mediaUrl,
    mediaNode?.directPath,
    mediaNode?.fileUrl,
    mediaNode?.downloadUrl,
    mediaNode?.fileSha256 && `sha256:${mediaNode.fileSha256}`,
    mediaNode?.mediaKey && `mediaKey:${mediaNode.mediaKey}`,
    mediaNode?.id,
    mediaNode?.fileName
  ].find(Boolean);

  return typeof candidate === 'string' ? candidate : '';
}

function isLikelyWasenderMessageEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return Boolean(
    payload?.key ||
    payload?.messageBody ||
    payload?.message?.conversation ||
    payload?.message?.extendedTextMessage?.text ||
    payload?.message?.audioMessage ||
    payload?.message?.imageMessage ||
    payload?.message?.videoMessage ||
    payload?.message?.documentMessage ||
    payload?.message?.stickerMessage
  );
}

function isConfirmationMessageKind(kind) {
  return kind === 'text' || kind === 'audio';
}

function isPlainConfirmationReply(message) {
  return message.kind === 'text' && ['1', '2'].includes(String(message.textBody || '').trim());
}

function extractFeedbackToken(textBody, captionText) {
  const haystack = `${String(textBody || '')}\n${String(captionText || '')}`;
  const match = haystack.match(/\b(FDBK-(?:\d+|TEST-[A-Z0-9-]+))\b/iu);
  if (!match) {
    return null;
  }

  const value = match[1];
  return {
    value,
    type: normalizeFeedbackTokenValue(value).startsWith('FDBK-TEST-')
      ? 'self_test'
      : 'numeric'
  };
}

function buildReducedPayloadSnapshot(message) {
  const payload = {
    providerMessageId: message.providerMessageId || '',
    senderPhone: message.senderPhone || '',
    senderRaw: message.senderRaw || '',
    timestamp: message.timestamp || '',
    kind: message.kind || 'unknown',
    textBody: message.textBody || '',
    captionText: message.captionText || '',
    mediaRef: message.mediaRef || '',
    mimeType: message.mimeType || '',
    rawKeys: Object.keys(message.rawMessage || {}).sort()
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_FEEDBACK_PAYLOAD_JSON_LENGTH) {
    return serialized;
  }

  return JSON.stringify({
    providerMessageId: payload.providerMessageId,
    senderPhone: payload.senderPhone,
    timestamp: payload.timestamp,
    kind: payload.kind,
    rawKeys: payload.rawKeys
  });
}

function buildCanonicalInboundMessageKey({
  senderPhone,
  senderRaw,
  recipientRaw,
  rawTimestamp,
  kind,
  textBody,
  captionText,
  mediaRef,
  mimeType
}) {
  const canonicalPayload = {
    senderPhone: normalizePhone(senderPhone),
    senderRaw: String(senderRaw || '').trim(),
    recipientRaw: String(recipientRaw || '').trim(),
    rawTimestamp: String(rawTimestamp || '').trim(),
    kind: String(kind || 'unknown'),
    textBody: normalizeDedupeText(textBody),
    captionText: normalizeDedupeText(captionText),
    mediaRef: String(mediaRef || '').trim(),
    mimeType: String(mimeType || '').trim()
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');
}

function normalizeDedupeText(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

function summarizeWasenderRequestStatus(messageStatuses) {
  if (!messageStatuses.length) {
    return 'ignored_non_message';
  }
  if (messageStatuses.length === 1) {
    return messageStatuses[0];
  }
  if (messageStatuses.every((status) => status === 'ignored_non_message' || status === 'unmatched_inbound')) {
    return 'ignored_non_message';
  }
  if (messageStatuses.some((status) => status.endsWith('_failed') || status === 'processing_failed')) {
    return 'batch_processed_with_failures';
  }

  return 'batch_processed';
}

function resolveInboundTimestamp(value) {
  if (!value && value !== 0) {
    return new Date().toISOString();
  }

  if (typeof value === 'number' || /^\d+$/u.test(String(value))) {
    const numericValue = Number(value);
    const timestamp = numericValue > 1e12 ? numericValue : numericValue * 1000;
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date().toISOString();
}

function buildFeedbackNote(message) {
  const kind = message.kind || 'unknown';
  if (kind === 'text') {
    const text = truncateForNote(message.textBody || message.captionText || '');
    return text
      ? `Feedback reply received via WhatsApp [text]: ${text}`
      : 'Feedback reply received via WhatsApp [text]';
  }

  return `Feedback reply received via WhatsApp [${kind}]`;
}

function buildOptOutWooOrderNote({ replyText, optedOutAt }) {
  return `RHYMAT_OPT_OUT=YES; source=whatsapp; reply=${sanitizeOptOutNoteValue(replyText)}; at=${sanitizeOptOutNoteValue(optedOutAt)}`;
}

function sanitizeOptOutNoteValue(value) {
  return String(value || '')
    .replace(/[;\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncateForNote(value, maxLength = 160) {
  const text = String(value || '').trim().replace(/\s+/gu, ' ');
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function extractMessageId(sendResult) {
  return sendResult?.id || sendResult?.messageId || sendResult?.data?.id || null;
}

function hashPayload(value) {
  try {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  } catch {
    return createHash('sha256').update(String(value || '')).digest('hex');
  }
}

function compareFeedbackCandidates(left, right) {
  const sentDelta = getTimestampValue(right?.feedbackSentAt || getFeedbackMeta(right).sentAt)
    - getTimestampValue(left?.feedbackSentAt || getFeedbackMeta(left).sentAt);
  if (sentDelta !== 0) {
    return sentDelta;
  }

  const requestedDelta = getTimestampValue(right?.feedbackRequestedAt || getFeedbackMeta(right).requestedAt)
    - getTimestampValue(left?.feedbackRequestedAt || getFeedbackMeta(left).requestedAt);
  if (requestedDelta !== 0) {
    return requestedDelta;
  }

  const updatedDelta = getTimestampValue(right?.updatedAt || right?.date_modified_gmt || right?.date_modified)
    - getTimestampValue(left?.updatedAt || left?.date_modified_gmt || left?.date_modified);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return Number(right?.orderId || right?.id || 0) - Number(left?.orderId || left?.id || 0);
}

function compareSelfTestFeedbackCandidates(left, right) {
  return compareFeedbackCandidates(left, right);
}

function compareApiOrdersByRecency(left, right) {
  return getApiOrderDateValue(right) - getApiOrderDateValue(left);
}

function getApiOrderDateValue(order) {
  const candidateValues = [
    order.updatedAt,
    order.decisionAt,
    order.lastReminderAt,
    order.confirmationSentAt
  ];

  for (const value of candidateValues) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return Number(order.orderId) || 0;
}

function getTimestampValue(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function buildFeedbackMetaUpdate(order, values) {
  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];

  return Object.entries({
    [FEEDBACK_META_KEYS.state]: values.state,
    [FEEDBACK_META_KEYS.replyAt]: values.replyAt,
    [FEEDBACK_META_KEYS.replyLastMessageId]: values.replyLastMessageId,
    [FEEDBACK_META_KEYS.replyCount]: values.replyCount,
    [FEEDBACK_META_KEYS.senderPhone]: values.senderPhone,
    [FEEDBACK_META_KEYS.lastKind]: values.lastKind,
    [FEEDBACK_META_KEYS.lastText]: values.lastText,
    [FEEDBACK_META_KEYS.lastCaption]: values.lastCaption,
    [FEEDBACK_META_KEYS.lastMediaUrl]: values.lastMediaUrl,
    [FEEDBACK_META_KEYS.lastMimeType]: values.lastMimeType,
    [FEEDBACK_META_KEYS.payloadJson]: values.payloadJson
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
}

function isProductionFeedbackOrder(order, messages, phone) {
  const feedbackMeta = getFeedbackMeta(order);
  if (feedbackMeta.state !== 'waiting_for_feedback') {
    return false;
  }

  if (isFeedbackSelfTestOrder(order)) {
    return false;
  }

  const normalizedOrder = normalizeWooOrder(order, messages);
  return normalizedOrder.phone === phone;
}

function isOrderOlderThan(order, now, maxAgeMs) {
  const raw = String(order?.date_created_gmt || '').trim();
  if (!raw) {
    return false;
  }

  const createdAtMs = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw) ? raw : `${raw}Z`);
  return !Number.isNaN(createdAtMs) && (now.getTime() - createdAtMs) > maxAgeMs;
}

function hasAmbiguousCustomerOutboundState(order, now = new Date()) {
  return [
    OUTBOUND_LOGICAL_KEYS.confirmationRequest,
    OUTBOUND_LOGICAL_KEYS.reminder1,
    OUTBOUND_LOGICAL_KEYS.reminder2,
    OUTBOUND_LOGICAL_KEYS.confirmationSuccess,
    OUTBOUND_LOGICAL_KEYS.cancellationSuccess,
    OUTBOUND_LOGICAL_KEYS.autoCancellation
  ].some((logicalKey) => {
    const outboundMeta = getOutboundReservationMeta(order, logicalKey);
    if (outboundMeta.state !== SEND_STATE.reserved) {
      return false;
    }
    const reservedAtMs = Date.parse(outboundMeta.reservedAt || '');
    return !Number.isNaN(reservedAtMs) && (now.getTime() - reservedAtMs) >= OUTBOUND_RESERVATION_STALE_MS;
  });
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

function buildUnreachableWhatsAppCancellationNote(emailStatus) {
  if (emailStatus === 'sent') {
    return 'Order cancelled automatically because the provided phone number is invalid or not reachable on WhatsApp. Customer email notification sent.';
  }

  if (emailStatus === 'skipped') {
    return 'Order cancelled automatically because the provided phone number is invalid or not reachable on WhatsApp. Customer email notification skipped because no billing email was available.';
  }

  return 'Order cancelled automatically because the provided phone number is invalid or not reachable on WhatsApp. Customer email notification failed.';
}

function safeErrorData(error) {
  try {
    return JSON.stringify(error?.data ?? null);
  } catch {
    return '"[unserializable]"';
  }
}

function isSameFinalDecision(order, inbound) {
  if (inbound.type !== 'text') {
    return false;
  }

  const reply = inbound.text.trim();
  if (reply !== '1' && reply !== '2') {
    return false;
  }

  const decisionMeta = getDecisionMeta(order.rawOrder || {});
  const decision = order.decision || decisionMeta.decision || '';
  return (reply === '1' && decision === DECISION.confirmed) || (reply === '2' && decision === DECISION.cancelled);
}
