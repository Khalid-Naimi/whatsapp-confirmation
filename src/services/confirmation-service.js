import { formatOrderTotal, interpolateTemplate, normalizePhone, summarizeOrderItems, validatePhone } from '../utils/format.js';
import { WasenderSendError } from './wasender-client.js';

const WORKFLOW_META_KEYS = {
  state: 'rhymat_whatsapp_state',
  confirmationSentAt: 'rhymat_whatsapp_confirmation_sent_at',
  reminderCount: 'rhymat_whatsapp_reminder_count',
  lastReminderAt: 'rhymat_whatsapp_last_reminder_at',
  cancelledAt: 'rhymat_whatsapp_cancelled_at'
};
const DECISION_META_KEYS = {
  decision: 'rhymat_whatsapp_decision',
  decisionAt: 'rhymat_whatsapp_decision_at',
  wooSyncStatus: 'rhymat_whatsapp_woo_sync_status',
  wooSyncAttempts: 'rhymat_whatsapp_woo_sync_attempts',
  lastSyncError: 'rhymat_whatsapp_last_sync_error',
  customerReplySent: 'rhymat_whatsapp_customer_reply_sent',
  cancellationReason: 'rhymat_whatsapp_cancellation_reason',
  internalNotifiedConfirmed: 'rhymat_whatsapp_internal_notified_confirmed',
  internalNotifiedCancelled: 'rhymat_whatsapp_internal_notified_cancelled',
  manualOverride: 'rhymat_whatsapp_manual_override',
  manualOverrideAt: 'rhymat_whatsapp_manual_override_at',
  manualOverrideStatus: 'rhymat_whatsapp_manual_override_status'
};
const FEEDBACK_META_KEYS = {
  state: 'rhymat_feedback_state',
  replyAt: 'rhymat_feedback_reply_at',
  replyLastMessageId: 'rhymat_feedback_reply_last_message_id',
  replyCount: 'rhymat_feedback_reply_count',
  senderPhone: 'rhymat_feedback_sender_phone',
  lastKind: 'rhymat_feedback_last_kind',
  lastText: 'rhymat_feedback_last_text',
  lastCaption: 'rhymat_feedback_last_caption',
  lastMediaUrl: 'rhymat_feedback_last_media_url',
  lastMimeType: 'rhymat_feedback_last_mime_type',
  payloadJson: 'rhymat_feedback_payload_json'
};
const FEEDBACK_TEST_META_KEYS = {
  token: 'rhymat_feedback_token',
  testPhone: 'rhymat_feedback_test_phone',
  testActive: 'rhymat_feedback_test_active',
  isTest: 'rhymat_feedback_is_test',
  testRunId: 'rhymat_feedback_test_run_id',
  requestedAt: 'rhymat_feedback_requested_at',
  sentAt: 'rhymat_feedback_sent_at'
};

const PROCESSING_STATUS = 'processing';
const RECONCILIATION_STATUSES = ['pending', 'processing', 'on-hold', 'cancelled', 'completed', 'failed', 'refunded'];
const REPLY_RECOVERY_STATUSES = ['pending', 'processing', 'on-hold', 'cancelled'];
const FEEDBACK_MATCH_STATUSES = ['pending', 'processing', 'on-hold', 'completed'];
const FIRST_REMINDER_MS = 24 * 60 * 60 * 1000;
const SECOND_REMINDER_MS = 48 * 60 * 60 * 1000;
const AUTO_CANCEL_MS = 72 * 60 * 60 * 1000;
const MAX_WOO_SYNC_ATTEMPTS = 6;
const MAX_FEEDBACK_PAYLOAD_JSON_LENGTH = 4000;

export class ConfirmationService {
  constructor({ store, wasenderClient, wooClient, mailService = null, messages, logger = console }) {
    this.store = store;
    this.wasenderClient = wasenderClient;
    this.wooClient = wooClient;
    this.mailService = mailService;
    this.messages = messages;
    this.logger = logger;
  }

  async processWooOrder(payload, eventKey) {
    if (this.store.hasProcessedEvent('woocommerce', eventKey)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    const workflow = getWorkflowMeta(payload);
    const normalizedOrder = normalizeWooOrder(payload, this.messages);
    const existing = this.store.getOrder(normalizedOrder.orderId);
    if (
      workflow.confirmationSentAt ||
      workflow.state === 'pending' ||
      workflow.state === 'confirmed' ||
      workflow.state === 'cancelled' ||
      existing?.confirmationState === 'pending_confirmation' ||
      existing?.confirmationState === 'confirmed' ||
      existing?.confirmationState === 'cancelled'
    ) {
      this.store.recordEvent('woocommerce', eventKey, payload, 'duplicate_order');
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    const result = await this.sendInitialConfirmation(payload, {
      note: 'WhatsApp confirmation sent to customer.'
    });
    this.logger.log(
      `[confirmation] order processed orderId=${normalizedOrder.orderId} result=${result.body?.reason || (result.body?.ok ? 'confirmation_sent' : 'unknown')}`
    );
    this.store.recordEvent('woocommerce', eventKey, payload, result.body.ok ? 'processed' : result.body.reason);
    return result;
  }

  async processWasenderInbound(payload, eventKey) {
    if (this.store.hasProcessedEvent('wasender', eventKey)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    const inboundMessages = extractWasenderInboundMessages(payload, eventKey, this.logger);
    if (!inboundMessages.length) {
      this.store.recordEvent('wasender', eventKey, payload, 'ignored_non_message');
      return { status: 200, body: { ok: true, ignored: true, messageCount: 0 } };
    }

    const summary = {
      messageCount: inboundMessages.length,
      processed: 0,
      ignored: 0,
      duplicates: 0,
      failed: 0,
      feedback: 0,
      confirmation: 0
    };
    const messageStatuses = [];

    for (const message of inboundMessages) {
      if (this.store.hasProcessedEvent('wasender_message', message.messageKey)) {
        summary.duplicates += 1;
        messageStatuses.push('duplicate_message');
        continue;
      }

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
      this.store.recordEvent('wasender_message', message.messageKey, message.rawEnvelopeSnapshot, eventStatus);
      messageStatuses.push(eventStatus);

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
    }

    const requestStatus = summarizeWasenderRequestStatus(messageStatuses);
    this.store.recordEvent('wasender', eventKey, payload, requestStatus);
    return {
      status: 200,
      body: {
        ok: true,
        ...summary
      }
    };
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

    const feedbackToken = extractFeedbackToken(message.textBody, message.captionText);
    if (feedbackToken) {
      this.logger.log(
        `[feedback] token detected type=${feedbackToken.type} token=${feedbackToken.value} messageKey=${message.messageKey}`
      );
      const feedbackMatch = await this.matchFeedbackOrder(message, { token: feedbackToken.value, explicitToken: true });
      this.logger.log(
        `[feedback] token route isolated type=${feedbackToken.type} token=${feedbackToken.value} outcome=${feedbackMatch.kind} messageKey=${message.messageKey}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    const feedbackFallbackMatch = await this.matchFeedbackOrder(message, { explicitToken: false });
    if (feedbackFallbackMatch.kind === 'matched') {
      return this.processFeedbackInboundMessage(message, feedbackFallbackMatch);
    }
    if (feedbackFallbackMatch.kind === 'ambiguous') {
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
        eventStatus: 'feedback_match_ambiguous'
      };
    }

    return this.routeConfirmationInboundMessage(message);
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

  async routeConfirmationInboundMessage(message) {
    if (!message.senderPhone || !isConfirmationMessageKind(message.kind)) {
      this.appendInboundMessage({
        message,
        orderId: null,
        storedKind: `unmatched_${message.kind || 'unknown'}`
      });
      return {
        ok: true,
        ignored: true,
        duplicate: false,
        failed: false,
        route: 'ignored',
        eventStatus: 'unmatched_inbound'
      };
    }

    const replyContext = await this.resolveReplyContext(message.senderPhone);
    if (!replyContext.pendingOrder) {
      const inbound = {
        type: message.kind,
        text: message.textBody
      };
      this.appendInboundMessage({
        message,
        orderId: replyContext.latestOrder?.orderId || null,
        storedKind: message.kind === 'audio' ? 'customer_audio_reply' : 'customer_reply'
      });

      if (replyContext.latestOrder && isSameFinalDecision(replyContext.latestOrder, inbound)) {
        return {
          ok: true,
          ignored: false,
          duplicate: true,
          failed: false,
          route: 'confirmation',
          eventStatus: 'duplicate_final_reply'
        };
      }

      return {
        ok: true,
        ignored: true,
        duplicate: false,
        failed: false,
        route: 'ignored',
        eventStatus: 'unmatched_inbound'
      };
    }

    return this.processConfirmationInboundMessage(message, replyContext);
  }

  async processConfirmationInboundMessage(message, replyContext) {
    const pendingOrder = replyContext.pendingOrder;
    const latestOrder = replyContext.latestOrder;

    this.appendInboundMessage({
      message,
      orderId: latestOrder?.orderId || null,
      storedKind: message.kind === 'audio' ? 'customer_audio_reply' : 'customer_reply'
    });

    const pendingCount = this.store.listPendingOrdersByPhone(message.senderPhone).length;
    if (pendingCount > 1) {
      this.logger.warn(`Multiple pending orders found for ${message.senderPhone}; using latest order ${pendingOrder.orderId}.`);
    }

    const reply = message.kind === 'audio' ? '' : String(message.textBody || '').trim();
    if (reply !== '1' && reply !== '2') {
      const invalidReplyCount = Number(pendingOrder.invalidReplyCount || 0);
      if (invalidReplyCount < 2) {
        try {
          const clarification = await this.wasenderClient.sendMessage({
            to: pendingOrder.phone,
            message: this.messages.invalidReply
          });
          this.store.appendMessage({
            source: 'outbound',
            orderId: pendingOrder.orderId,
            phone: pendingOrder.phone,
            kind: 'clarification',
            payload: clarification,
            text: this.messages.invalidReply
          });
          this.store.upsertOrder({
            ...pendingOrder,
            invalidReplyCount: invalidReplyCount + 1,
            manualFollowupRequired: false,
            confirmationState: 'pending_confirmation'
          });
        } catch (error) {
          this.logger.error(error);
          this.store.upsertOrder({
            ...pendingOrder,
            lastError: error.message
          });
        }
      } else {
        this.store.upsertOrder({
          ...pendingOrder,
          invalidReplyCount,
          manualFollowupRequired: true,
          confirmationState: 'pending_confirmation'
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

      return {
        ok: false,
        ignored: true,
        duplicate: false,
        failed: false,
        route: 'confirmation',
        eventStatus: 'invalid_reply',
        reason: 'invalid_reply'
      };
    }

    const nextState = reply === '1' ? 'confirmed' : 'cancelled';
    const nextWooStatus = reply === '1' ? 'on-hold' : 'cancelled';
    const note = reply === '1'
      ? 'Customer confirmed order via WhatsApp.'
      : 'Customer cancelled order via WhatsApp.';
    const followUpMessage = reply === '1'
      ? this.messages.confirmedReply
      : this.messages.cancelledReply;
    const nowIso = new Date().toISOString();
    const decisionMeta = getDecisionMeta(pendingOrder.rawOrder || {});
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
      wooSyncStatus: 'pending_retry',
      wooSyncAttempts: Number(pendingOrder.wooSyncAttempts || decisionMeta.wooSyncAttempts || 0),
      lastSyncError: '',
      customerReplySent: customerReplySent || 'no'
    });

    try {
      const decisionOrder = await this.persistDecisionMeta({
        orderPayload: pendingOrder.rawOrder || {},
        orderId: pendingOrder.orderId,
        state: nextState,
        nowIso,
        customerReplySent: customerReplySent || 'no',
        wooSyncStatus: 'pending_retry',
        wooSyncAttempts: nextOrderState.wooSyncAttempts || 0,
        lastSyncError: ''
      });
      nextOrderState = this.store.upsertOrder({
        ...nextOrderState,
        rawOrder: decisionOrder || nextOrderState.rawOrder
      });
    } catch (error) {
      this.logger.warn(`Unable to persist decision meta for order ${pendingOrder.orderId}: ${error.message}`);
    }

    if ((nextOrderState.customerReplySent || 'no') !== 'yes') {
      nextOrderState = this.store.upsertOrder({
        ...nextOrderState,
        customerReplySent: 'yes'
      });
      try {
        const updatedOrder = await this.persistDecisionMeta({
          orderPayload: nextOrderState.rawOrder || pendingOrder.rawOrder || {},
          orderId: pendingOrder.orderId,
          state: nextState,
          nowIso,
          customerReplySent: 'yes',
          wooSyncStatus: nextOrderState.wooSyncStatus || 'pending_retry',
          wooSyncAttempts: nextOrderState.wooSyncAttempts || 0,
          lastSyncError: nextOrderState.lastSyncError || ''
        });
        nextOrderState = this.store.upsertOrder({
          ...nextOrderState,
          rawOrder: updatedOrder || nextOrderState.rawOrder
        });
      } catch (error) {
        this.logger.warn(`Unable to mark customer reply as sent for order ${pendingOrder.orderId}: ${error.message}`);
      }

      await this.safeSendTrackedMessage({
        phone: pendingOrder.phone,
        orderId: pendingOrder.orderId,
        kind: reply === '1' ? 'confirmation_success' : 'cancellation_success',
        message: followUpMessage
      });
    }

    nextOrderState = await this.sendInternalDecisionNotifications({
      order: nextOrderState,
      decision: nextState,
      alreadyNotified: nextState === 'confirmed'
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
          `[feedback] self-test token matched token=${parsedToken.value} orderId=${String(orders[0].id)} runId=${feedbackMeta.testRunId || ''} messageKey=${message.messageKey}`
        );
        return {
          kind: 'matched',
          orderId: String(orders[0].id),
          order: orders[0],
          source: 'self_test_token'
        };
      }
      if (orders.length > 1) {
        this.logger.warn(
          `[feedback] ambiguous self-test token token=${parsedToken.value} matches=${orders.map((order) => order.id).join(',')} messageKey=${message.messageKey}`
        );
        return { kind: 'ambiguous', source: 'self_test_token' };
      }

      this.logger.warn(
        `[feedback] unmatched self-test token token=${parsedToken.value} messageKey=${message.messageKey}`
      );
      return { kind: 'unmatched', source: 'self_test_token' };
    }

    if (!message.senderPhone) {
      return { kind: 'unmatched', source: 'phone' };
    }

    const matches = await this.findFeedbackOrdersByPhone(message.senderPhone);
    if (matches.testPhoneMatches.length === 1) {
      const order = matches.testPhoneMatches[0];
      const feedbackMeta = getFeedbackMeta(order);
      this.logger.log(
        `[feedback] self-test phone matched phone=${message.senderPhone} orderId=${String(order.id)} runId=${feedbackMeta.testRunId || ''} messageKey=${message.messageKey}`
      );
      return {
        kind: 'matched',
        orderId: String(order.id),
        order,
        source: 'test_phone'
      };
    }
    if (matches.testPhoneMatches.length > 1) {
      this.logger.warn(
        `[feedback] ambiguous self-test phone phone=${message.senderPhone} matches=${matches.testPhoneMatches.map((order) => order.id).join(',')} messageKey=${message.messageKey}`
      );
      return { kind: 'ambiguous', source: 'test_phone' };
    }

    if (matches.orderPhoneMatches.length === 1) {
      return {
        kind: 'matched',
        orderId: String(matches.orderPhoneMatches[0].id),
        order: matches.orderPhoneMatches[0],
        source: 'phone'
      };
    }
    if (matches.orderPhoneMatches.length > 1) {
      this.logger.warn(
        `[feedback] ambiguous phone fallback phone=${message.senderPhone} matches=${matches.orderPhoneMatches.map((order) => order.id).join(',')}`
      );
      return { kind: 'ambiguous', source: 'phone' };
    }

    return { kind: 'unmatched', source: 'phone' };
  }

  async processFeedbackInboundMessage(message, feedbackMatch) {
    const feedbackOrder = feedbackMatch.order || await this.wooClient.getOrder(feedbackMatch.orderId);
    const normalizedOrder = normalizeWooOrder(feedbackOrder, this.messages);
    const localOrder = this.store.getOrder(normalizedOrder.orderId);
    const replyAt = resolveInboundTimestamp(message.timestamp);
    const providerMessageId = message.providerMessageId || message.messageKey;
    const feedbackMeta = getFeedbackMeta(feedbackOrder);

    this.appendInboundMessage({
      message,
      orderId: normalizedOrder.orderId,
      storedKind: `feedback_${message.kind || 'unknown'}`
    });

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
      this.logger.warn(`[feedback] failed Woo meta update orderId=${normalizedOrder.orderId} messageKey=${message.messageKey} error=${error.message}`);
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
  }

  async findFeedbackOrdersByToken(token) {
    const orders = await this.listOrdersForStatuses(FEEDBACK_MATCH_STATUSES);
    const normalizedToken = normalizeFeedbackTokenValue(token);
    return orders
      .filter((order) => {
        const feedbackMeta = getFeedbackMeta(order);
        return feedbackMeta.state === 'waiting_for_feedback' && normalizeFeedbackTokenValue(feedbackMeta.token) === normalizedToken;
      })
      .sort(compareOrdersByRecency);
  }

  async findFeedbackOrdersByPhone(phone) {
    const orders = await this.listOrdersForStatuses(FEEDBACK_MATCH_STATUSES);
    const testPhoneMatches = [];
    const orderPhoneMatches = [];

    for (const order of orders) {
      const normalizedOrder = normalizeWooOrder(order, this.messages);
      const feedbackMeta = getFeedbackMeta(order);
      if (feedbackMeta.state !== 'waiting_for_feedback') {
        continue;
      }

      if (feedbackMeta.testPhone && phone === feedbackMeta.testPhone && isSelfTestFeedbackMeta(feedbackMeta)) {
        testPhoneMatches.push(order);
        continue;
      }

      if (normalizedOrder.phone === phone) {
        orderPhoneMatches.push(order);
      }
    }

    return {
      testPhoneMatches: testPhoneMatches.sort(compareOrdersByRecency),
      orderPhoneMatches: orderPhoneMatches.sort(compareOrdersByRecency)
    };
  }

  async runOrderFollowups({ now = new Date(), backfillOnly = false } = {}) {
    const summary = {
      backfilled: 0,
      remindersSent: 0,
      autoCancelled: 0,
      skipped: 0,
      errors: 0
    };

    const orders = await this.listOrdersForStatuses(RECONCILIATION_STATUSES);

    for (const order of orders) {
        const workflow = getWorkflowMeta(order);
        const decisionMeta = getDecisionMeta(order);
        const localOrder = this.store.getOrder(String(order.id));

        try {
          const effectiveDecision = decisionMeta.decision || localOrder?.decision || '';
          const manualOverride = decisionMeta.manualOverride || localOrder?.manualOverride || '';
          if (manualOverride === 'yes') {
            summary.skipped += 1;
            continue;
          }

          if (effectiveDecision) {
            const targetWooStatus = effectiveDecision === 'confirmed' ? 'on-hold' : 'cancelled';
            const currentSyncStatus = decisionMeta.wooSyncStatus || localOrder?.wooSyncStatus || '';
            if (currentSyncStatus === 'manual') {
              summary.skipped += 1;
              continue;
            }

            if (order.status !== targetWooStatus && currentSyncStatus !== 'pending_retry') {
              await this.markManualOverride({
                order: {
                  ...localOrder,
                  ...normalizeWooOrder(order, this.messages),
                  rawOrder: order,
                  decision: effectiveDecision,
                  decisionAt: decisionMeta.decisionAt || localOrder?.decisionAt || ''
                },
                status: order.status
              });
              summary.skipped += 1;
              continue;
            }

            if (currentSyncStatus === 'pending_retry') {
              const reconciliation = await this.reconcileWooDecision({
                order: {
                  ...localOrder,
                  ...normalizeWooOrder(order, this.messages),
                  rawOrder: order
                },
                targetState: effectiveDecision,
                targetWooStatus,
                note: effectiveDecision === 'confirmed'
                  ? 'Customer confirmed order via WhatsApp.'
                  : 'Customer cancelled order via WhatsApp.',
                nowIso: decisionMeta.decisionAt || localOrder?.decisionAt || now.toISOString()
              });
              if (reconciliation.success) {
                summary.skipped += 1;
              } else {
                summary.errors += 1;
              }
              continue;
            }

            summary.skipped += 1;
            continue;
          }

          if (order.status !== PROCESSING_STATUS) {
            if (workflow.confirmationSentAt) {
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
                summary.skipped += 1;
                continue;
              }
            }
            summary.skipped += 1;
            continue;
          }

          if (!workflow.confirmationSentAt) {
            const result = await this.sendInitialConfirmation(order, {
              note: 'WhatsApp confirmation backfill sent.',
              now
            });
            if (result.body.ok) {
              summary.backfilled += 1;
            } else {
              summary.errors += 1;
            }
            continue;
          }

          if (backfillOnly) {
            summary.skipped += 1;
            continue;
          }

          if (workflow.state === 'confirmed' || workflow.state === 'cancelled') {
            summary.skipped += 1;
            continue;
          }

          const confirmationSentAt = new Date(workflow.confirmationSentAt);
          if (Number.isNaN(confirmationSentAt.getTime())) {
            summary.skipped += 1;
            continue;
          }

          const ageMs = now.getTime() - confirmationSentAt.getTime();

          if (ageMs >= AUTO_CANCEL_MS && workflow.reminderCount >= 2) {
            await this.autoCancelPendingOrder(order, now);
            summary.autoCancelled += 1;
            continue;
          }

          if (ageMs >= SECOND_REMINDER_MS && workflow.reminderCount === 1) {
            await this.sendReminder(order, 2, now);
            summary.remindersSent += 1;
            continue;
          }

          if (ageMs >= FIRST_REMINDER_MS && workflow.reminderCount === 0) {
            await this.sendReminder(order, 1, now);
            summary.remindersSent += 1;
            continue;
          }

          summary.skipped += 1;
        } catch (error) {
          this.logger.error(error);
          summary.errors += 1;
        }
      }

    return summary;
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

  async resolveReplyContext(phone) {
    const localPendingOrder = this.store.findLatestPendingOrderByPhone(phone);
    const localLatestOrder = localPendingOrder || this.store.findLatestOrderByPhone(phone);
    if (localPendingOrder) {
      return {
        pendingOrder: localPendingOrder,
        latestOrder: localLatestOrder,
        matchedViaWooFallback: false
      };
    }

    const recoveredOrder = await this.findPendingWooOrderByPhone(phone);
    if (!recoveredOrder) {
      return {
        pendingOrder: null,
        latestOrder: localLatestOrder,
        matchedViaWooFallback: false
      };
    }

    const storedRecoveredOrder = this.store.upsertOrder({
      ...normalizeWooOrder(recoveredOrder, this.messages),
      rawOrder: recoveredOrder,
      confirmationState: 'pending_confirmation',
      invalidReplyCount: 0,
      manualFollowupRequired: false
    });

    return {
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

    try {
      const sendResult = await this.wasenderClient.sendMessage({
        to: normalizedOrder.phone,
        message
      });

      const updatedOrder = await this.wooClient.updateOrderMeta(
        normalizedOrder.orderId,
        mergeMetaUpdates(
          buildWorkflowMetaUpdate(orderPayload, {
            state: 'pending',
            confirmationSentAt: now.toISOString(),
            reminderCount: 0,
            lastReminderAt: '',
            cancelledAt: ''
          }),
          buildDecisionMetaUpdate(orderPayload, {
            decision: '',
            decisionAt: '',
            wooSyncStatus: '',
            wooSyncAttempts: 0,
            lastSyncError: '',
            customerReplySent: 'no'
            ,
            internalNotifiedConfirmed: 'no',
            internalNotifiedCancelled: 'no'
          })
        )
      );

      this.store.upsertOrder({
        ...normalizedOrder,
        rawOrder: updatedOrder || orderPayload,
        confirmationState: 'pending_confirmation',
        invalidReplyCount: 0,
        manualFollowupRequired: false,
        wasenderMessageId: extractMessageId(sendResult)
      });
      this.store.appendMessage({
        source: 'outbound',
        orderId: normalizedOrder.orderId,
        phone: normalizedOrder.phone,
        kind: 'confirmation_request',
        payload: sendResult,
        text: message
      });

      await this.safeAddOrderNote(normalizedOrder.orderId, note);
      this.logger.log(`[confirmation] initial send accepted orderId=${normalizedOrder.orderId} phone=${normalizedOrder.phone}`);

      return { status: 202, body: { ok: true } };
    } catch (error) {
      if (isWhatsAppContactabilityFailure(error)) {
        this.logger.warn(
          `[confirmation] classified invalid_or_non_whatsapp_number orderId=${normalizedOrder.orderId} status=${String(error.status || '')} body=${safeErrorData(error)}`
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
      return { status: 502, body: { ok: false, reason: 'send_failed' } };
    }
  }

  async sendReminder(orderPayload, reminderCount, now) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const message = interpolateTemplate(this.messages.reminderMessage, buildTemplateValues(normalizedOrder));
    const sendResult = await this.wasenderClient.sendMessage({
      to: normalizedOrder.phone,
      message
    });
    const updatedOrder = await this.wooClient.updateOrderMeta(
      normalizedOrder.orderId,
      buildWorkflowMetaUpdate(orderPayload, {
        state: 'pending',
        reminderCount,
        lastReminderAt: now.toISOString()
      })
    );

    this.store.appendMessage({
      source: 'outbound',
      orderId: normalizedOrder.orderId,
      phone: normalizedOrder.phone,
      kind: `reminder_${reminderCount}`,
      payload: sendResult,
      text: message
    });
    this.store.upsertOrder({
      ...normalizedOrder,
      rawOrder: updatedOrder || orderPayload,
      confirmationState: 'pending_confirmation',
      invalidReplyCount: 0,
      manualFollowupRequired: false
    });
    await this.safeAddOrderNote(normalizedOrder.orderId, `WhatsApp reminder #${reminderCount} sent.`);
  }

  async autoCancelPendingOrder(orderPayload, now) {
    const normalizedOrder = normalizeWooOrder(orderPayload, this.messages);
    const statusUpdatedOrder = await this.wooClient.updateOrderStatus(normalizedOrder.orderId, 'cancelled');
    const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
      normalizedOrder.orderId,
      buildWorkflowMetaUpdate(statusUpdatedOrder || orderPayload, {
        state: 'cancelled',
        cancelledAt: now.toISOString()
      })
    );
    await this.safeAddOrderNote(normalizedOrder.orderId, 'Order auto-cancelled after 72h without WhatsApp confirmation.');
    await this.safeSendTrackedMessage({
      phone: normalizedOrder.phone,
      orderId: normalizedOrder.orderId,
      kind: 'auto_cancellation',
      message: this.messages.cancelledReply
    });
    this.store.upsertOrder({
      ...normalizedOrder,
      rawOrder: metaUpdatedOrder || statusUpdatedOrder || orderPayload,
      confirmationState: 'cancelled',
      wooStatus: 'cancelled',
      finalReply: 'timeout'
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
    const statusUpdatedOrder = await this.wooClient.updateOrderStatus(normalizedOrder.orderId, 'cancelled');
    const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
      normalizedOrder.orderId,
      mergeMetaUpdates(
        buildWorkflowMetaUpdate(statusUpdatedOrder || orderPayload, {
          state: 'cancelled',
          cancelledAt: nowIso
        }),
        buildDecisionMetaUpdate(statusUpdatedOrder || orderPayload, {
          decision: 'cancelled',
          decisionAt: nowIso,
          wooSyncStatus: 'synced',
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
      wooStatus: 'cancelled',
      decision: 'cancelled',
      decisionAt: nowIso,
      wooSyncStatus: 'synced',
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

  async safeSendTrackedMessage({ phone, orderId, kind, message }) {
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

      this.logger.log(`[confirmation] sending cancellation email orderId=${order.orderId} to=${order.customerEmail}`);
      await this.mailService.send({
        to: order.customerEmail,
        subject,
        text
      });
      this.logger.log(`[confirmation] cancellation email sent orderId=${order.orderId} to=${order.customerEmail}`);
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

    const template = decision === 'confirmed'
      ? this.messages.internalConfirmedTemplate
      : this.messages.internalCancelledTemplate;
    const message = interpolateTemplate(template, buildTemplateValues(order));

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
          kind: decision === 'confirmed' ? 'internal_confirmed_notification' : 'internal_cancelled_notification',
          payload: result,
          text: message
        });
      } catch (error) {
        this.logger.warn(`Unable to send internal ${decision} notification for order ${order.orderId} to ${phone}: ${error.message}`);
      }
    }

    const nextOrder = this.store.upsertOrder({
      ...order,
      internalNotifiedConfirmed: decision === 'confirmed' ? 'yes' : order.internalNotifiedConfirmed || 'no',
      internalNotifiedCancelled: decision === 'cancelled' ? 'yes' : order.internalNotifiedCancelled || 'no'
    });

    try {
      const updatedOrder = await this.wooClient.updateOrderMeta(
        order.orderId,
        buildDecisionMetaUpdate(order.rawOrder || {}, {
          internalNotifiedConfirmed: decision === 'confirmed' ? 'yes' : nextOrder.internalNotifiedConfirmed || 'no',
          internalNotifiedCancelled: decision === 'cancelled' ? 'yes' : nextOrder.internalNotifiedCancelled || 'no'
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

  async markManualOverride({ order, status }) {
    const normalizedOrder = {
      ...order,
      manualOverride: 'yes',
      manualOverrideAt: new Date().toISOString(),
      manualOverrideStatus: status,
      confirmationState: 'manual',
      wooSyncStatus: 'manual'
    };

    this.store.upsertOrder(normalizedOrder);

    try {
      const updatedOrder = await this.wooClient.updateOrderMeta(
        normalizedOrder.orderId,
        mergeMetaUpdates(
          buildWorkflowMetaUpdate(normalizedOrder.rawOrder || {}, {
            state: 'manual'
          }),
          buildDecisionMetaUpdate(normalizedOrder.rawOrder || {}, {
            decision: normalizedOrder.decision || '',
            decisionAt: normalizedOrder.decisionAt || '',
            wooSyncStatus: 'manual',
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
  }

  async listOrdersForStatuses(statuses) {
    if (typeof this.wooClient.listOrdersByStatuses === 'function') {
      return this.wooClient.listOrdersByStatuses(statuses);
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

  async findPendingWooOrderByPhone(phone) {
    const candidateOrders = await this.listOrdersForStatuses(REPLY_RECOVERY_STATUSES);

    return candidateOrders
      .filter((order) => {
        const workflow = getWorkflowMeta(order);
        const decisionMeta = getDecisionMeta(order);
        const normalizedOrder = normalizeWooOrder(order, this.messages);

        return normalizedOrder.phone === phone
          && workflow.state === 'pending'
          && Boolean(workflow.confirmationSentAt)
          && !decisionMeta.decision;
      })
      .sort(compareOrdersByRecency)[0] || null;
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
          cancelledAt: state === 'cancelled' ? nowIso : ''
        }),
        buildDecisionMetaUpdate(orderPayload, {
          decision: state,
          decisionAt: nowIso,
          wooSyncStatus,
          wooSyncAttempts,
          lastSyncError,
          customerReplySent
        })
      )
    );
  }

  async reconcileWooDecision({ order, targetState, targetWooStatus, note, nowIso }) {
    const currentAttempts = Number(order.wooSyncAttempts || getDecisionMeta(order.rawOrder || {}).wooSyncAttempts || 0);
    const attemptNumber = currentAttempts + 1;
    let rawOrder = order.rawOrder || {};

    try {
      const updatedOrder = await this.wooClient.updateOrder(order.orderId, {
        status: targetWooStatus,
        meta_data: mergeMetaUpdates(
          buildWorkflowMetaUpdate(rawOrder, {
            state: targetState,
            cancelledAt: targetState === 'cancelled' ? nowIso : ''
          }),
          buildDecisionMetaUpdate(rawOrder, {
            decision: targetState,
            decisionAt: nowIso,
            wooSyncStatus: 'synced',
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
        wooSyncStatus: 'synced',
        wooSyncAttempts: attemptNumber,
        lastSyncError: ''
      });
      return { success: true, syncStatus: 'synced', rawOrder };
    } catch (error) {
      const syncStatus = attemptNumber >= MAX_WOO_SYNC_ATTEMPTS ? 'manual' : 'pending_retry';
      this.store.upsertOrder({
        ...order,
        confirmationState: targetState,
        decision: targetState,
        decisionAt: order.decisionAt || nowIso,
        wooSyncStatus: syncStatus,
        wooSyncAttempts: attemptNumber,
        lastSyncError: error.message
      });
      // Best-effort status-only fallback: if the combined atomic call was rejected
      // (e.g. WooCommerce or a plugin refuses the larger payload), at least push
      // the status change so the order isn't stuck in 'processing'.
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
  }
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
    invalidReplyCount: Number(localOrder?.invalidReplyCount || 0),
    manualFollowupRequired: Boolean(localOrder?.manualFollowupRequired),
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
    manualOverrideStatus: decisionMeta.manualOverrideStatus || String(localOrder?.manualOverrideStatus || '')
  };
}

function deriveApiStatus({ workflow, decision, localOrder }) {
  if (decision.manualOverride === 'yes' || decision.wooSyncStatus === 'manual') {
    return 'manual';
  }

  if (decision.decision === 'confirmed') {
    return 'confirmed';
  }

  if (decision.decision === 'cancelled' || workflow.state === 'cancelled') {
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

function normalizeWooOrder(payload, messages) {
  const billing = payload.billing || {};
  const shipping = payload.shipping || {};
  const billingState = String(billing.state || payload.billing_state || '').trim();
  const deliveryAddress = String(billing.address_1 || payload.billing_address_1 || '').trim() || 'Ma kaynach';
  const shippingCity = String(shipping.city || '').trim();
  const billingCity = String(billing.city || '').trim();
  const resolvedCity = billingState || shippingCity || billingCity;
  const deliveryCity = resolvedCity || messages.defaultCityLabel;
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  return {
    orderId: String(payload.id),
    phone: normalizePhone(billing.phone || shipping.phone),
    customerEmail: String(billing.email || '').trim(),
    customerName: [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim(),
    total: payload.total,
    currency: payload.currency,
    deliveryAddress,
    deliveryCity,
    deliveryEta: resolveDeliveryEta(resolvedCity, messages),
    lineItems,
    orderItemsSummary: summarizeOrderItems(lineItems),
    wooStatus: payload.status || 'pending',
    rawOrder: payload
  };
}

function buildTemplateValues(normalizedOrder) {
  return {
    customerName: normalizedOrder.customerName || 'l3ziz(a)',
    orderId: normalizedOrder.orderId,
    orderTotal: formatOrderTotal(normalizedOrder),
    customerPhone: normalizedOrder.phone || '',
    customerEmail: normalizedOrder.customerEmail || '',
    orderItemsSummary: normalizedOrder.orderItemsSummary,
    deliveryAddress: normalizedOrder.deliveryAddress,
    deliveryCity: normalizedOrder.deliveryCity,
    deliveryEta: normalizedOrder.deliveryEta,
    decision: normalizedOrder.decision || normalizedOrder.confirmationState || '',
    storeName: normalizedOrder.storeName || ''
  };
}

function resolveDeliveryEta(city, messages) {
  return city === 'Casablanca'
    ? messages.deliveryEtaCasablanca
    : messages.deliveryEtaOtherCities;
}

function extractWasenderInboundMessages(payload, eventKey, logger = console) {
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
  const timestamp = resolveInboundTimestamp(
    message?.messageTimestamp ||
    message?.timestamp ||
    messageKey?.messageTimestamp ||
    payload?.timestamp ||
    payload?.data?.timestamp
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

  return {
    webhookEventKey: eventKey,
    messageIndex: index,
    messageKey: providerMessageId || `${eventKey}:${index}`,
    providerMessageId: providerMessageId || null,
    senderPhone: normalizePhone(senderRaw),
    senderRaw: String(senderRaw || ''),
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

function compareOrdersByRecency(left, right) {
  return getOrderDateValue(right) - getOrderDateValue(left);
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

function getOrderDateValue(order) {
  const candidateValues = [
    order?.date_created_gmt,
    order?.date_created,
    order?.date_modified_gmt,
    order?.date_modified
  ];

  for (const value of candidateValues) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return Number(order?.id) || 0;
}

function getWorkflowMeta(order) {
  const metaValue = (key) => {
    const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
    const metaItem = metaData.find((item) => item.key === key);
    return metaItem?.value ?? '';
  };

  return {
    state: String(metaValue(WORKFLOW_META_KEYS.state) || ''),
    confirmationSentAt: String(metaValue(WORKFLOW_META_KEYS.confirmationSentAt) || ''),
    reminderCount: Number(metaValue(WORKFLOW_META_KEYS.reminderCount) || 0),
    lastReminderAt: String(metaValue(WORKFLOW_META_KEYS.lastReminderAt) || ''),
    cancelledAt: String(metaValue(WORKFLOW_META_KEYS.cancelledAt) || '')
  };
}

function getDecisionMeta(order) {
  const metaValue = (key) => {
    const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
    const metaItem = metaData.find((item) => item.key === key);
    return metaItem?.value ?? '';
  };

  return {
    decision: String(metaValue(DECISION_META_KEYS.decision) || ''),
    decisionAt: String(metaValue(DECISION_META_KEYS.decisionAt) || ''),
    wooSyncStatus: String(metaValue(DECISION_META_KEYS.wooSyncStatus) || ''),
    wooSyncAttempts: Number(metaValue(DECISION_META_KEYS.wooSyncAttempts) || 0),
    lastSyncError: String(metaValue(DECISION_META_KEYS.lastSyncError) || ''),
    customerReplySent: String(metaValue(DECISION_META_KEYS.customerReplySent) || ''),
    cancellationReason: String(metaValue(DECISION_META_KEYS.cancellationReason) || ''),
    internalNotifiedConfirmed: String(metaValue(DECISION_META_KEYS.internalNotifiedConfirmed) || ''),
    internalNotifiedCancelled: String(metaValue(DECISION_META_KEYS.internalNotifiedCancelled) || ''),
    manualOverride: String(metaValue(DECISION_META_KEYS.manualOverride) || ''),
    manualOverrideAt: String(metaValue(DECISION_META_KEYS.manualOverrideAt) || ''),
    manualOverrideStatus: String(metaValue(DECISION_META_KEYS.manualOverrideStatus) || '')
  };
}

function getFeedbackMeta(order) {
  const metaValue = (key) => {
    const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
    const metaItem = metaData.find((item) => item.key === key);
    return metaItem?.value ?? '';
  };

  return {
    state: String(metaValue(FEEDBACK_META_KEYS.state) || ''),
    replyAt: String(metaValue(FEEDBACK_META_KEYS.replyAt) || ''),
    replyLastMessageId: String(metaValue(FEEDBACK_META_KEYS.replyLastMessageId) || ''),
    replyCount: Number(metaValue(FEEDBACK_META_KEYS.replyCount) || 0),
    senderPhone: String(metaValue(FEEDBACK_META_KEYS.senderPhone) || ''),
    lastKind: String(metaValue(FEEDBACK_META_KEYS.lastKind) || ''),
    lastText: String(metaValue(FEEDBACK_META_KEYS.lastText) || ''),
    lastCaption: String(metaValue(FEEDBACK_META_KEYS.lastCaption) || ''),
    lastMediaUrl: String(metaValue(FEEDBACK_META_KEYS.lastMediaUrl) || ''),
    lastMimeType: String(metaValue(FEEDBACK_META_KEYS.lastMimeType) || ''),
    payloadJson: String(metaValue(FEEDBACK_META_KEYS.payloadJson) || ''),
    token: String(metaValue(FEEDBACK_TEST_META_KEYS.token) || ''),
    testPhone: normalizePhone(metaValue(FEEDBACK_TEST_META_KEYS.testPhone) || ''),
    testActive: parseMetaBoolean(metaValue(FEEDBACK_TEST_META_KEYS.testActive)),
    isTest: parseMetaBoolean(metaValue(FEEDBACK_TEST_META_KEYS.isTest)),
    testRunId: String(metaValue(FEEDBACK_TEST_META_KEYS.testRunId) || ''),
    requestedAt: String(metaValue(FEEDBACK_TEST_META_KEYS.requestedAt) || ''),
    sentAt: String(metaValue(FEEDBACK_TEST_META_KEYS.sentAt) || '')
  };
}

function buildWorkflowMetaUpdate(order, values) {
  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];

  return Object.entries({
    [WORKFLOW_META_KEYS.state]: values.state,
    [WORKFLOW_META_KEYS.confirmationSentAt]: values.confirmationSentAt,
    [WORKFLOW_META_KEYS.reminderCount]: values.reminderCount,
    [WORKFLOW_META_KEYS.lastReminderAt]: values.lastReminderAt,
    [WORKFLOW_META_KEYS.cancelledAt]: values.cancelledAt
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
}

function buildDecisionMetaUpdate(order, values) {
  const existingMeta = Array.isArray(order?.meta_data) ? order.meta_data : [];

  return Object.entries({
    [DECISION_META_KEYS.decision]: values.decision,
    [DECISION_META_KEYS.decisionAt]: values.decisionAt,
    [DECISION_META_KEYS.wooSyncStatus]: values.wooSyncStatus,
    [DECISION_META_KEYS.wooSyncAttempts]: values.wooSyncAttempts,
    [DECISION_META_KEYS.lastSyncError]: values.lastSyncError,
    [DECISION_META_KEYS.customerReplySent]: values.customerReplySent,
    [DECISION_META_KEYS.cancellationReason]: values.cancellationReason,
    [DECISION_META_KEYS.internalNotifiedConfirmed]: values.internalNotifiedConfirmed,
    [DECISION_META_KEYS.internalNotifiedCancelled]: values.internalNotifiedCancelled,
    [DECISION_META_KEYS.manualOverride]: values.manualOverride,
    [DECISION_META_KEYS.manualOverrideAt]: values.manualOverrideAt,
    [DECISION_META_KEYS.manualOverrideStatus]: values.manualOverrideStatus
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const existing = existingMeta.find((item) => item.key === key);
      return existing?.id
        ? { id: existing.id, key, value }
        : { key, value };
    });
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

function normalizeFeedbackTokenValue(token) {
  return String(token || '').trim().toUpperCase();
}

function classifyFeedbackToken(token) {
  const normalized = normalizeFeedbackTokenValue(token);
  if (/^FDBK-\d+$/u.test(normalized)) {
    return {
      value: normalized,
      type: 'numeric',
      orderId: normalized.slice('FDBK-'.length)
    };
  }

  if (/^FDBK-TEST-[A-Z0-9-]+$/u.test(normalized)) {
    return {
      value: normalized,
      type: 'self_test'
    };
  }

  return null;
}

function parseMetaBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isSelfTestFeedbackMeta(feedbackMeta) {
  return feedbackMeta.testActive || feedbackMeta.isTest;
}

function mergeMetaUpdates(...metaSets) {
  const merged = new Map();
  for (const metaSet of metaSets) {
    for (const item of metaSet) {
      merged.set(item.key, item);
    }
  }
  return [...merged.values()];
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
  return (reply === '1' && decision === 'confirmed') || (reply === '2' && decision === 'cancelled');
}
