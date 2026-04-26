import { createHash } from 'node:crypto';
import { formatOrderTotal, interpolateTemplate, normalizePhone, summarizeOrderItems, validatePhone } from '../utils/format.js';
import { WasenderSendError } from './wasender-client.js';

const WORKFLOW_META_KEYS = {
  state: 'rhymat_whatsapp_state',
  confirmationSentAt: 'rhymat_whatsapp_confirmation_sent_at',
  reminderCount: 'rhymat_whatsapp_reminder_count',
  lastReminderAt: 'rhymat_whatsapp_last_reminder_at',
  cancelledAt: 'rhymat_whatsapp_cancelled_at',
  confirmationMessageId: 'rhymat_whatsapp_confirmation_message_id',
  reminder1SentAt: 'rhymat_whatsapp_reminder_1_sent_at',
  reminder1MessageId: 'rhymat_whatsapp_reminder_1_message_id',
  reminder2SentAt: 'rhymat_whatsapp_reminder_2_sent_at',
  reminder2MessageId: 'rhymat_whatsapp_reminder_2_message_id'
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
  manualOverrideStatus: 'rhymat_whatsapp_manual_override_status',
  invalidReplyCount: 'rhymat_whatsapp_invalid_reply_count',
  manualFollowupRequired: 'rhymat_whatsapp_manual_followup_required'
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
const FEEDBACK_MATCH_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled'];
const FEEDBACK_RECOVERY_PER_PAGE = 50;
const FEEDBACK_RECOVERY_MAX_PAGES = 2;
const FIRST_REMINDER_MS = 24 * 60 * 60 * 1000;
const SECOND_REMINDER_MS = 48 * 60 * 60 * 1000;
const AUTO_CANCEL_MS = 72 * 60 * 60 * 1000;
const MAX_WOO_SYNC_ATTEMPTS = 6;
const MAX_FEEDBACK_PAYLOAD_JSON_LENGTH = 4000;
const OUTBOUND_LOGICAL_KEYS = {
  confirmationRequest: 'customer:confirmation_request',
  reminder1: 'customer:reminder_1',
  reminder2: 'customer:reminder_2',
  clarification1: 'customer:clarification_1',
  clarification2: 'customer:clarification_2',
  confirmationSuccess: 'customer:confirmation_success',
  cancellationSuccess: 'customer:cancellation_success',
  autoCancellation: 'customer:auto_cancellation'
};

export class ConfirmationService {
  constructor({ store, wasenderClient, wooClient, workflowRepository, mailService = null, messages, logger = console }) {
    if (!workflowRepository) {
      throw new Error('ConfirmationService requires a workflowRepository');
    }

    this.store = store;
    this.wasenderClient = wasenderClient;
    this.wooClient = wooClient;
    this.workflowRepository = workflowRepository;
    this.mailService = mailService;
    this.messages = messages;
    this.logger = logger;
    this.activeOrderLocks = new Map();
  }

  async withOrderLock(orderId, work) {
    const lockKey = `order:${orderId}`;
    const currentDepth = this.activeOrderLocks.get(lockKey) || 0;
    if (currentDepth > 0) {
      this.activeOrderLocks.set(lockKey, currentDepth + 1);
      try {
        return await work();
      } finally {
        this.activeOrderLocks.set(lockKey, currentDepth);
      }
    }

    const lock = await this.workflowRepository.acquireLock(lockKey);
    if (!lock.acquired) {
      this.logger.log(`[lock] skip lockKey=${lockKey} reason=in_flight`);
      return { locked: false };
    }

    this.logger.log(`[lock] acquired lockKey=${lockKey}`);
    this.activeOrderLocks.set(lockKey, 1);
    try {
      return await work();
    } finally {
      this.activeOrderLocks.delete(lockKey);
      await this.workflowRepository.releaseLock(lockKey);
      this.logger.log(`[lock] released lockKey=${lockKey}`);
    }
  }

  async processWooOrder(payload, eventKey) {
    const eventLock = await this.workflowRepository.acquireLock(`woo_event:${eventKey}`);
    if (!eventLock.acquired) {
      this.store.recordEvent('woocommerce', eventKey, payload, 'duplicate_order');
      return { status: 200, body: { ok: true, duplicate: true, reason: 'event_in_flight' } };
    }

    try {
      const reservation = await this.workflowRepository.reserveEvent({
        source: 'woocommerce',
        eventKey,
        orderId: String(payload?.id || ''),
        payloadHash: hashPayload(payload)
      });
      if (reservation.status === 'existing') {
        this.store.recordEvent('woocommerce', eventKey, payload, 'duplicate_order');
        return { status: 200, body: { ok: true, duplicate: true } };
      }

      const workflow = getWorkflowMeta(payload);
      const normalizedOrder = normalizeWooOrder(payload, this.messages);
      const result = await this.withOrderLock(normalizedOrder.orderId, async () => {
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
          return { status: 200, body: { ok: true, duplicate: true, reason: 'duplicate_order' } };
        }

        if (isFeedbackSelfTestOrder(payload)) {
          const feedbackMeta = getFeedbackMeta(payload);
          this.store.upsertOrder({
            ...normalizedOrder,
            rawOrder: payload
          });
          this.logger.log(
            `[confirmation] skipped self-test confirmation send orderId=${normalizedOrder.orderId} testPhone=${feedbackMeta.testPhone || ''} token=${feedbackMeta.token || ''} runId=${feedbackMeta.testRunId || ''}`
          );
          return {
            status: 200,
            body: { ok: true, skipped: true, reason: 'feedback_self_test' }
          };
        }

        const sendResult = await this.sendInitialConfirmation(payload, {
          note: 'WhatsApp confirmation sent to customer.'
        });
        this.logger.log(
          `[confirmation] order processed orderId=${normalizedOrder.orderId} result=${sendResult.body?.reason || (sendResult.body?.ok ? 'confirmation_sent' : 'unknown')}`
        );
        return sendResult;
      });

      if (result?.locked === false) {
        await this.workflowRepository.markEventStatus({
          source: 'woocommerce',
          eventKey,
          status: 'duplicate_in_flight',
          orderId: normalizedOrder.orderId
        });
        this.store.recordEvent('woocommerce', eventKey, payload, 'duplicate_in_flight');
        return { status: 200, body: { ok: true, duplicate: true, reason: 'order_in_flight' } };
      }

      const eventStatus = result.body?.duplicate
        ? 'duplicate_order'
        : result.body?.reason === 'feedback_self_test'
          ? 'feedback_self_test_skipped_confirmation'
          : (result.body?.reason || (result.body?.ok ? 'processed' : 'processing_failed'));
      await this.workflowRepository.markEventStatus({
        source: 'woocommerce',
        eventKey,
        status: eventStatus,
        orderId: normalizedOrder.orderId
      });
      this.store.recordEvent('woocommerce', eventKey, payload, eventStatus);
      return result;
    } catch (error) {
      await this.workflowRepository.markEventStatus({
        source: 'woocommerce',
        eventKey,
        status: 'processing_failed',
        orderId: String(payload?.id || '')
      });
      this.store.recordEvent('woocommerce', eventKey, payload, 'processing_failed');
      throw error;
    } finally {
      await this.workflowRepository.releaseLock(`woo_event:${eventKey}`);
    }
  }

  async processWasenderInbound(payload, eventKey) {
    const eventLock = await this.workflowRepository.acquireLock(`wasender_event:${eventKey}`);
    if (!eventLock.acquired) {
      this.store.recordEvent('wasender', eventKey, payload, 'duplicate_request');
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    try {
      const requestReservation = await this.workflowRepository.reserveEvent({
        source: 'wasender',
        eventKey,
        payloadHash: hashPayload(payload)
      });
      if (requestReservation.status === 'existing') {
        this.store.recordEvent('wasender', eventKey, payload, 'duplicate_request');
        return { status: 200, body: { ok: true, duplicate: true } };
      }

      const inboundMessages = extractWasenderInboundMessages(payload, eventKey, this.logger);
      if (!inboundMessages.length) {
        await this.workflowRepository.markEventStatus({
          source: 'wasender',
          eventKey,
          status: 'ignored_non_message'
        });
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
        const messageReservation = await this.workflowRepository.reserveEvent({
          source: 'wasender_message',
          eventKey: message.messageKey,
          payloadHash: hashPayload(message.rawEnvelopeSnapshot)
        });
        if (messageReservation.status === 'existing') {
          summary.duplicates += 1;
          messageStatuses.push('duplicate_message');
          this.store.recordEvent('wasender_message', message.messageKey, message.rawEnvelopeSnapshot, 'duplicate_message');
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
        await this.workflowRepository.markEventStatus({
          source: 'wasender_message',
          eventKey: message.messageKey,
          status: eventStatus
        });
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
      await this.workflowRepository.markEventStatus({
        source: 'wasender',
        eventKey,
        status: requestStatus
      });
      this.store.recordEvent('wasender', eventKey, payload, requestStatus);
      return {
        status: 200,
        body: {
          ok: true,
          ...summary
        }
      };
    } catch (error) {
      await this.workflowRepository.markEventStatus({
        source: 'wasender',
        eventKey,
        status: 'processing_failed'
      });
      this.store.recordEvent('wasender', eventKey, payload, 'processing_failed');
      throw error;
    } finally {
      await this.workflowRepository.releaseLock(`wasender_event:${eventKey}`);
    }
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
      const feedbackMatch = await this.matchFeedbackOrder(message, { token: feedbackToken.value, explicitToken: true });
      this.logger.log(
        `[feedback] route=token_match type=${feedbackToken.type} token=${feedbackToken.value} outcome=${feedbackMatch.kind} senderPhone=${message.senderPhone || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    const localPendingOrder = message.senderPhone
      ? this.store.findLatestPendingOrderByPhone(message.senderPhone)
      : null;
    if (localPendingOrder) {
      this.logger.log(
        `[inbound] route=confirmation_local_pending senderPhone=${message.senderPhone} pendingOrderId=${localPendingOrder.orderId} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}`
      );
      return this.routeConfirmationInboundMessage(message);
    }

    if (isPlainConfirmationReply(message)) {
      this.logger.log(
        `[inbound] route=confirmation_candidate senderPhone=${message.senderPhone || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}`
      );
      return this.routeConfirmationInboundMessage(message);
    }

    const feedbackMatch = await this.matchFeedbackOrder(message);
    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'self_test_phone_local') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=self_test_phone_match source=local matchedOrderId=${feedbackMatch.orderId} senderPhone=${message.senderPhone || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'self_test_phone_woo_recovery') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=self_test_phone_match source=woo_recovery matchedOrderId=${feedbackMatch.orderId} senderPhone=${message.senderPhone || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'production_phone_local') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=production_phone_match source=local matchedOrderId=${feedbackMatch.orderId} senderPhone=${message.senderPhone || ''} senderRaw=${message.senderRaw || ''} recipient=${message.recipientRaw || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (feedbackMatch.kind === 'matched' && feedbackMatch.source === 'production_phone_woo_recovery') {
      const candidateSuffix = feedbackMatch.matchedOrderIds?.length > 1
        ? ` candidateOrderIds=${feedbackMatch.matchedOrderIds.join(',')} chosenOrderId=${feedbackMatch.orderId}`
        : '';
      this.logger.log(
        `[feedback] route=production_phone_match source=woo_recovery matchedOrderId=${feedbackMatch.orderId} senderPhone=${message.senderPhone || ''} senderRaw=${message.senderRaw || ''} recipient=${message.recipientRaw || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}${candidateSuffix}`
      );
      return this.processFeedbackMatchResult(message, feedbackMatch);
    }

    if (message.senderPhone && isConfirmationMessageKind(message.kind)) {
      const recoveredPendingOrder = await this.findPendingWooOrderByPhone(message.senderPhone);
      if (recoveredPendingOrder) {
        this.logger.log(
          `[inbound] route=confirmation_candidate source=woo_pending senderPhone=${message.senderPhone || ''} kind=${message.kind || 'unknown'} messageKey=${message.messageKey}`
        );
        return this.routeConfirmationInboundMessage(message);
      }
    }

    this.logger.log(
      `[feedback] route=feedback_unmatched senderPhone=${message.senderPhone || ''} senderRaw=${message.senderRaw || ''} recipient=${message.recipientRaw || ''} kind=${message.kind || 'unknown'} source=${feedbackMatch.source || 'unknown'} reason=${feedbackMatch.reason || 'no_match'} messageKey=${message.messageKey}`
    );
    return this.processFeedbackMatchResult(message, feedbackMatch);
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

    const result = await this.withOrderLock(pendingOrder.orderId, async () => {
      const reply = message.kind === 'audio' ? '' : String(message.textBody || '').trim();
      const decisionMeta = getDecisionMeta(pendingOrder.rawOrder || {});
      const currentInvalidReplyCount = Number(
        pendingOrder.invalidReplyCount
        ?? decisionMeta.invalidReplyCount
        ?? 0
      );
      const currentManualFollowupRequired = pendingOrder.manualFollowupRequired === true
        || decisionMeta.manualFollowupRequired === 'yes';

      if (reply !== '1' && reply !== '2') {
        if (currentManualFollowupRequired) {
          this.store.upsertOrder({
            ...pendingOrder,
            invalidReplyCount: currentInvalidReplyCount,
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

        const nextInvalidReplyCount = Math.min(currentInvalidReplyCount + 1, 2);
        const nextManualFollowupRequired = nextInvalidReplyCount >= 2;
        let conversationOrder = pendingOrder.rawOrder || {};

        try {
          const updatedConversationOrder = await this.persistConversationState({
            orderPayload: pendingOrder.rawOrder || {},
            orderId: pendingOrder.orderId,
            invalidReplyCount: nextInvalidReplyCount,
            manualFollowupRequired: nextManualFollowupRequired
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
          confirmationState: 'pending_confirmation'
        });

        const clarificationLogicalKey = nextInvalidReplyCount === 1
          ? OUTBOUND_LOGICAL_KEYS.clarification1
          : OUTBOUND_LOGICAL_KEYS.clarification2;
        await this.safeSendTrackedMessage({
          phone: pendingOrder.phone,
          orderId: pendingOrder.orderId,
          logicalKey: clarificationLogicalKey,
          kind: 'clarification',
          message: this.messages.invalidReply
        });

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

      const nextState = reply === '1' ? 'confirmed' : 'cancelled';
      const nextWooStatus = reply === '1' ? 'on-hold' : 'cancelled';
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
        wooSyncStatus: 'pending_retry',
        wooSyncAttempts: Number(pendingOrder.wooSyncAttempts || decisionMeta.wooSyncAttempts || 0),
        lastSyncError: '',
        customerReplySent: customerReplySent || 'no',
        invalidReplyCount: currentInvalidReplyCount,
        manualFollowupRequired: false
      });

      try {
        const decisionOrder = await this.persistWorkflowAndDecisionMeta({
          orderPayload: pendingOrder.rawOrder || {},
          orderId: pendingOrder.orderId,
          workflowValues: {
            state: nextState,
            cancelledAt: nextState === 'cancelled' ? nowIso : ''
          },
          decisionValues: {
            decision: nextState,
            decisionAt: nowIso,
            wooSyncStatus: 'pending_retry',
            wooSyncAttempts: nextOrderState.wooSyncAttempts || 0,
            lastSyncError: '',
            customerReplySent: customerReplySent || 'no',
            invalidReplyCount: currentInvalidReplyCount,
            manualFollowupRequired: 'no'
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
        nextOrderState = this.store.upsertOrder({
          ...nextOrderState,
          customerReplySent: 'yes'
        });
        try {
          const updatedOrder = await this.persistWorkflowAndDecisionMeta({
            orderPayload: nextOrderState.rawOrder || pendingOrder.rawOrder || {},
            orderId: pendingOrder.orderId,
            workflowValues: {
              state: nextState,
              cancelledAt: nextState === 'cancelled' ? nowIso : ''
            },
            decisionValues: {
              decision: nextState,
              decisionAt: nowIso,
              customerReplySent: 'yes',
              wooSyncStatus: nextOrderState.wooSyncStatus || 'pending_retry',
              wooSyncAttempts: nextOrderState.wooSyncAttempts || 0,
              lastSyncError: nextOrderState.lastSyncError || '',
              invalidReplyCount: currentInvalidReplyCount,
              manualFollowupRequired: 'no'
            }
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
          logicalKey: reply === '1'
            ? OUTBOUND_LOGICAL_KEYS.confirmationSuccess
            : OUTBOUND_LOGICAL_KEYS.cancellationSuccess,
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
    });

    if (result?.locked === false) {
      return {
        ok: true,
        ignored: true,
        duplicate: true,
        failed: false,
        route: 'confirmation',
        eventStatus: 'duplicate_in_flight'
      };
    }

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
    const feedbackOrder = feedbackMatch.order || await this.wooClient.getOrder(feedbackMatch.orderId);
    const normalizedOrder = normalizeWooOrder(feedbackOrder, this.messages);
    const localOrder = this.store.getOrder(normalizedOrder.orderId);
    this.appendInboundMessage({
      message,
      orderId: normalizedOrder.orderId,
      storedKind: `feedback_${message.kind || 'unknown'}`
    });

    const result = await this.withOrderLock(normalizedOrder.orderId, async () => {
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
          `[feedback] failed Woo meta update orderId=${normalizedOrder.orderId} wooBaseUrl=${String(this.wooClient?.baseUrl || '')} senderPhone=${message.senderPhone || ''} senderRaw=${message.senderRaw || ''} recipient=${message.recipientRaw || ''} messageKey=${message.messageKey} error=${error.message}`
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

    if (result?.locked === false) {
      return {
        ok: true,
        ignored: true,
        duplicate: true,
        failed: false,
        route: 'feedback',
        eventStatus: 'feedback_duplicate'
      };
    }

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
      repaired: 0,
      skipped: 0,
      errors: 0
    };

    const repairCandidates = await this.workflowRepository.listRepairableOutboundMessages();
    for (const reservation of repairCandidates) {
      try {
        const repairResult = await this.withOrderLock(reservation.orderId, async () => this.repairAcceptedOutboundMessage(reservation));
        if (repairResult?.locked === false) {
          summary.skipped += 1;
          continue;
        }
        if (repairResult) {
          summary.repaired += 1;
        }
      } catch (error) {
        this.logger.error(error);
        summary.errors += 1;
      }
    }

    const orders = await this.listOrdersForStatuses(RECONCILIATION_STATUSES);

    for (const order of orders) {
      const workflow = getWorkflowMeta(order);
      const decisionMeta = getDecisionMeta(order);
      const localOrder = this.store.getOrder(String(order.id));
      const orderId = String(order.id);

      try {
        const action = await this.withOrderLock(orderId, async () => {
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
            const targetWooStatus = effectiveDecision === 'confirmed' ? 'on-hold' : 'cancelled';
            const currentSyncStatus = decisionMeta.wooSyncStatus || localOrder?.wooSyncStatus || '';
            if (currentSyncStatus === 'manual') {
              return 'skipped';
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
              return 'skipped';
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
              return reconciliation.success ? 'skipped' : 'error';
            }

            return 'skipped';
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
                this.logFollowupDecision({
                  orderId,
                  orderStatus: order.status,
                  workflowState: workflow.state,
                  confirmationSentAt: workflow.confirmationSentAt,
                  reminderCount: workflow.reminderCount,
                  action: 'skip_not_processing'
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
              action: 'skip_not_processing'
            });
            return 'skipped';
          }

          if (!workflow.confirmationSentAt) {
            if (isFeedbackSelfTestOrder(order)) {
              const feedbackMeta = getFeedbackMeta(order);
              this.logger.log(
                `[confirmation] skipped self-test confirmation backfill orderId=${String(order.id)} testPhone=${feedbackMeta.testPhone || ''} token=${feedbackMeta.token || ''} runId=${feedbackMeta.testRunId || ''}`
              );
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

          if (workflow.state === 'confirmed' || workflow.state === 'cancelled') {
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

          if (ageMs >= AUTO_CANCEL_MS && workflow.reminderCount >= 2) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              ageMs,
              action: 'auto_cancel'
            });
            await this.autoCancelPendingOrder(order, now);
            return 'autoCancelled';
          }

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
            return await this.sendReminder(order, 1, now) ? 'reminderSent' : 'skipped';
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

        if (action?.locked === false) {
          summary.skipped += 1;
        } else if (action === 'backfilled') {
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

  async reserveAndSendLogicalMessage({
    orderId,
    phone,
    logicalKey,
    kind,
    message,
    persistAfterSend = null,
    repairAfterAccepted = null
  }) {
    const reservation = await this.workflowRepository.reserveOutboundMessage({
      orderId,
      logicalKey,
      recipientPhone: phone,
      messageBody: message
    });

    if (reservation.status === 'in_progress') {
      return { ok: true, duplicate: true, inProgress: true, record: reservation.record };
    }

    if (reservation.status === 'send_accepted' || reservation.status === 'persisted') {
      if (repairAfterAccepted) {
        await repairAfterAccepted({ reservation: reservation.record });
      }
      return { ok: true, duplicate: true, record: reservation.record };
    }

    if (reservation.status !== 'reserved') {
      throw new Error(`Unexpected outbound reservation status: ${reservation.status}`);
    }

    let sendResult;
    try {
      sendResult = await this.wasenderClient.sendMessage({
        to: phone,
        message
      });
    } catch (error) {
      await this.workflowRepository.markOutboundFailed({
        orderId,
        logicalKey,
        error: error.message
      });
      throw error;
    }

    const acceptedAt = new Date().toISOString();
    const providerMessageId = extractMessageId(sendResult) || '';
    await this.workflowRepository.markOutboundAccepted({
      orderId,
      logicalKey,
      providerMessageId,
      acceptedAt,
      providerPayload: sendResult
    });
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
          sendResult
        });
        await this.workflowRepository.markOutboundPersisted({ orderId, logicalKey });
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
          acceptedAt,
          providerMessageId,
          sendResult,
          error
        };
      }
    }

    await this.workflowRepository.markOutboundPersisted({ orderId, logicalKey });
    return {
      ok: true,
      duplicate: false,
      persisted: true,
      acceptedAt,
      providerMessageId,
      sendResult
    };
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

  async repairAcceptedOutboundMessage(reservation) {
    if (!reservation) {
      return false;
    }

    const order = await this.wooClient.getOrder(reservation.orderId);
    const normalizedOrder = normalizeWooOrder(order, this.messages);

    if (reservation.logicalKey === OUTBOUND_LOGICAL_KEYS.confirmationRequest) {
      await this.persistInitialConfirmationMeta({
        orderPayload: order,
        normalizedOrder,
        acceptedAt: reservation.acceptedAt || new Date().toISOString(),
        providerMessageId: reservation.providerMessageId || ''
      });
      await this.workflowRepository.markOutboundPersisted({
        orderId: reservation.orderId,
        logicalKey: reservation.logicalKey
      });
      return true;
    }

    if (reservation.logicalKey === OUTBOUND_LOGICAL_KEYS.reminder1 || reservation.logicalKey === OUTBOUND_LOGICAL_KEYS.reminder2) {
      const reminderCount = reservation.logicalKey === OUTBOUND_LOGICAL_KEYS.reminder1 ? 1 : 2;
      await this.persistReminderMeta({
        orderPayload: order,
        normalizedOrder,
        reminderCount,
        acceptedAt: reservation.acceptedAt || new Date().toISOString(),
        providerMessageId: reservation.providerMessageId || ''
      });
      await this.workflowRepository.markOutboundPersisted({
        orderId: reservation.orderId,
        logicalKey: reservation.logicalKey
      });
      return true;
    }

    await this.workflowRepository.markOutboundPersisted({
      orderId: reservation.orderId,
      logicalKey: reservation.logicalKey
    });
    this.store.upsertOrder({
      ...normalizedOrder,
      rawOrder: order
    });
    return true;
  }

  async persistInitialConfirmationMeta({ orderPayload, normalizedOrder, acceptedAt, providerMessageId }) {
    const updatedOrder = await this.persistWorkflowAndDecisionMeta({
      orderPayload,
      orderId: normalizedOrder.orderId,
      workflowValues: {
        state: 'pending',
        confirmationSentAt: acceptedAt,
        reminderCount: 0,
        lastReminderAt: '',
        cancelledAt: '',
        confirmationMessageId: providerMessageId || ''
      },
      decisionValues: {
        decision: '',
        decisionAt: '',
        wooSyncStatus: '',
        wooSyncAttempts: 0,
        lastSyncError: '',
        customerReplySent: 'no',
        internalNotifiedConfirmed: 'no',
        internalNotifiedCancelled: 'no',
        invalidReplyCount: 0,
        manualFollowupRequired: 'no'
      }
    });

    const persistedOrder = updatedOrder || orderPayload;
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

  async persistReminderMeta({ orderPayload, normalizedOrder, reminderCount, acceptedAt, providerMessageId }) {
    const decisionMeta = getDecisionMeta(orderPayload);
    const updatedOrder = await this.persistWorkflowAndDecisionMeta({
      orderPayload,
      orderId: normalizedOrder.orderId,
      workflowValues: {
        state: 'pending',
        reminderCount,
        lastReminderAt: acceptedAt,
        reminder1SentAt: reminderCount === 1 ? acceptedAt : undefined,
        reminder1MessageId: reminderCount === 1 ? (providerMessageId || '') : undefined,
        reminder2SentAt: reminderCount === 2 ? acceptedAt : undefined,
        reminder2MessageId: reminderCount === 2 ? (providerMessageId || '') : undefined
      },
      decisionValues: {
        invalidReplyCount: decisionMeta.invalidReplyCount,
        manualFollowupRequired: decisionMeta.manualFollowupRequired || 'no'
      }
    });

    const persistedOrder = updatedOrder || orderPayload;
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

  async persistConversationState({ orderPayload, orderId, invalidReplyCount, manualFollowupRequired }) {
    return this.persistWorkflowAndDecisionMeta({
      orderPayload,
      orderId,
      decisionValues: {
        invalidReplyCount,
        manualFollowupRequired: manualFollowupRequired ? 'yes' : 'no'
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
      invalidReplyCount: getDecisionMeta(recoveredOrder).invalidReplyCount,
      manualFollowupRequired: getDecisionMeta(recoveredOrder).manualFollowupRequired === 'yes'
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
    const acceptedAtFallback = now.toISOString();

    try {
      const sendOutcome = await this.reserveAndSendLogicalMessage({
        orderId: normalizedOrder.orderId,
        phone: normalizedOrder.phone,
        logicalKey: OUTBOUND_LOGICAL_KEYS.confirmationRequest,
        kind: 'confirmation_request',
        message,
        repairAfterAccepted: async ({ reservation }) => {
          await this.repairAcceptedOutboundMessage(reservation);
        },
        persistAfterSend: async ({ acceptedAt, providerMessageId }) => {
          const persistedOrder = await this.persistInitialConfirmationMeta({
            orderPayload,
            normalizedOrder,
            acceptedAt: acceptedAt || acceptedAtFallback,
            providerMessageId
          });
          await this.safeAddOrderNote(normalizedOrder.orderId, note);
          return persistedOrder;
        }
      });

      if (sendOutcome.inProgress) {
        return { status: 202, body: { ok: true, duplicate: true, reason: 'confirmation_in_flight' } };
      }

      if (sendOutcome.duplicate) {
        const currentReservation = sendOutcome.record
          || await this.workflowRepository.getOutboundMessage(normalizedOrder.orderId, OUTBOUND_LOGICAL_KEYS.confirmationRequest);
        if (currentReservation) {
          await this.repairAcceptedOutboundMessage(currentReservation);
        }
      }

      if (!sendOutcome.persisted) {
        this.store.upsertOrder({
          ...normalizedOrder,
          rawOrder: orderPayload,
          confirmationState: 'pending_confirmation',
          confirmationSentAt: sendOutcome.acceptedAt || acceptedAtFallback,
          invalidReplyCount: 0,
          manualFollowupRequired: false,
          wasenderMessageId: sendOutcome.providerMessageId || ''
        });
      }

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
    const logicalKey = reminderCount === 1
      ? OUTBOUND_LOGICAL_KEYS.reminder1
      : OUTBOUND_LOGICAL_KEYS.reminder2;
    const sendOutcome = await this.reserveAndSendLogicalMessage({
      orderId: normalizedOrder.orderId,
      phone: normalizedOrder.phone,
      logicalKey,
      kind: `reminder_${reminderCount}`,
      message,
      repairAfterAccepted: async ({ reservation }) => {
        await this.repairAcceptedOutboundMessage(reservation);
      },
      persistAfterSend: async ({ acceptedAt, providerMessageId }) => {
        const persistedOrder = await this.persistReminderMeta({
          orderPayload,
          normalizedOrder,
          reminderCount,
          acceptedAt: acceptedAt || now.toISOString(),
          providerMessageId
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
        manualFollowupRequired: decisionMeta.manualFollowupRequired === 'yes'
      });
    }

    return true;
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
      logicalKey: OUTBOUND_LOGICAL_KEYS.autoCancellation,
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

  async safeSendTrackedMessage({ phone, orderId, logicalKey, kind, message }) {
    try {
      const result = await this.reserveAndSendLogicalMessage({
        orderId,
        phone,
        logicalKey: logicalKey || `internal:${kind}:${phone}`,
        kind,
        message
      });
      return result.sendResult || result.record || null;
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
        const result = await this.reserveAndSendLogicalMessage({
          orderId: order.orderId,
          phone,
          logicalKey: `internal:${decision}:${phone}`,
          kind: decision === 'confirmed' ? 'internal_confirmed_notification' : 'internal_cancelled_notification',
          message
        });
        void result;
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
    return this.withOrderLock(order.orderId, async () => {
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

      return true;
    });
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
  const feedbackMeta = getFeedbackMeta(payload);
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
    feedbackState: feedbackMeta.state || '',
    feedbackToken: feedbackMeta.token || '',
    feedbackTestPhone: feedbackMeta.testPhone || '',
    feedbackTestActive: feedbackMeta.testActive,
    feedbackIsTest: feedbackMeta.isTest,
    feedbackTestRunId: feedbackMeta.testRunId || '',
    feedbackRequestedAt: feedbackMeta.requestedAt || '',
    feedbackSentAt: feedbackMeta.sentAt || '',
    feedbackReplyAt: feedbackMeta.replyAt || '',
    feedbackReplyLastMessageId: feedbackMeta.replyLastMessageId || '',
    feedbackReplyCount: Number(feedbackMeta.replyCount || 0),
    feedbackSenderPhone: feedbackMeta.senderPhone || '',
    feedbackLastKind: feedbackMeta.lastKind || '',
    feedbackLastText: feedbackMeta.lastText || '',
    feedbackLastCaption: feedbackMeta.lastCaption || '',
    feedbackLastMediaUrl: feedbackMeta.lastMediaUrl || '',
    feedbackLastMimeType: feedbackMeta.lastMimeType || '',
    invalidReplyCount: getDecisionMeta(payload).invalidReplyCount,
    manualFollowupRequired: getDecisionMeta(payload).manualFollowupRequired === 'yes',
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

function getTimestampValue(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isNaN(timestamp) ? 0 : timestamp;
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
    cancelledAt: String(metaValue(WORKFLOW_META_KEYS.cancelledAt) || ''),
    confirmationMessageId: String(metaValue(WORKFLOW_META_KEYS.confirmationMessageId) || ''),
    reminder1SentAt: String(metaValue(WORKFLOW_META_KEYS.reminder1SentAt) || ''),
    reminder1MessageId: String(metaValue(WORKFLOW_META_KEYS.reminder1MessageId) || ''),
    reminder2SentAt: String(metaValue(WORKFLOW_META_KEYS.reminder2SentAt) || ''),
    reminder2MessageId: String(metaValue(WORKFLOW_META_KEYS.reminder2MessageId) || '')
  };
}

function getDecisionMeta(order) {
  const metaData = Array.isArray(order?.meta_data) ? order.meta_data : [];
  const metaItem = (key) => metaData.find((item) => item.key === key);
  const metaValue = (key) => {
    return metaItem(key)?.value ?? '';
  };

  return {
    decision: String(metaValue(DECISION_META_KEYS.decision) || ''),
    decisionAt: String(metaValue(DECISION_META_KEYS.decisionAt) || ''),
    wooSyncStatus: String(metaValue(DECISION_META_KEYS.wooSyncStatus) || ''),
    wooSyncAttempts: metaItem(DECISION_META_KEYS.wooSyncAttempts)
      ? Number(metaValue(DECISION_META_KEYS.wooSyncAttempts) || 0)
      : undefined,
    lastSyncError: String(metaValue(DECISION_META_KEYS.lastSyncError) || ''),
    customerReplySent: String(metaValue(DECISION_META_KEYS.customerReplySent) || ''),
    cancellationReason: String(metaValue(DECISION_META_KEYS.cancellationReason) || ''),
    internalNotifiedConfirmed: String(metaValue(DECISION_META_KEYS.internalNotifiedConfirmed) || ''),
    internalNotifiedCancelled: String(metaValue(DECISION_META_KEYS.internalNotifiedCancelled) || ''),
    manualOverride: String(metaValue(DECISION_META_KEYS.manualOverride) || ''),
    manualOverrideAt: String(metaValue(DECISION_META_KEYS.manualOverrideAt) || ''),
    manualOverrideStatus: String(metaValue(DECISION_META_KEYS.manualOverrideStatus) || ''),
    invalidReplyCount: metaItem(DECISION_META_KEYS.invalidReplyCount)
      ? Number(metaValue(DECISION_META_KEYS.invalidReplyCount) || 0)
      : undefined,
    manualFollowupRequired: String(metaValue(DECISION_META_KEYS.manualFollowupRequired) || '')
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
    [WORKFLOW_META_KEYS.cancelledAt]: values.cancelledAt,
    [WORKFLOW_META_KEYS.confirmationMessageId]: values.confirmationMessageId,
    [WORKFLOW_META_KEYS.reminder1SentAt]: values.reminder1SentAt,
    [WORKFLOW_META_KEYS.reminder1MessageId]: values.reminder1MessageId,
    [WORKFLOW_META_KEYS.reminder2SentAt]: values.reminder2SentAt,
    [WORKFLOW_META_KEYS.reminder2MessageId]: values.reminder2MessageId
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
    [DECISION_META_KEYS.manualOverrideStatus]: values.manualOverrideStatus,
    [DECISION_META_KEYS.invalidReplyCount]: values.invalidReplyCount,
    [DECISION_META_KEYS.manualFollowupRequired]: values.manualFollowupRequired
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

function isFeedbackSelfTestOrder(order) {
  const feedbackMeta = getFeedbackMeta(order);
  if (feedbackMeta.state !== 'waiting_for_feedback') {
    return false;
  }

  if (!isSelfTestFeedbackMeta(feedbackMeta)) {
    return false;
  }

  return Boolean(
    feedbackMeta.testPhone ||
    classifyFeedbackToken(feedbackMeta.token)?.type === 'self_test' ||
    feedbackMeta.testRunId
  );
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
