// Customer WhatsApp messages sent at most once: the reservation in the order meta (with the cross-instance claim,
// services/claim.js) is written before the provider call and closed after it; reservations left without an answer
// for 2 hours are closed by the hourly task. Methods run with the ConfirmationService as `this`.
// Moved unchanged out of confirmation-service.js.

import { OUTBOUND_LOGICAL_KEYS, OUTBOUND_META_KEYS, outboundClaimKey } from '../../../domain/order-meta.js';
import { assertTransition, OUTBOUND_SEND, SEND_STATE, WORKFLOW_STATE } from '../../../domain/order-states.js';
import { claim } from '../../claim.js';
import {
  buildLogicalSendMetaUpdate,
  buildWorkflowMetaUpdate,
  getOutboundReservationMeta,
  getWorkflowMeta,
  mergeMetaUpdates
} from '../order-helpers.js';

export const OUTBOUND_RESERVATION_STALE_MS = 2 * 60 * 60 * 1000;

// The first confirmation request of an order is never held for the quiet hours: the customer has just ordered, so they
// are awake, and it is sent once per order. Reminders, stage messages and everything else still wait for the window.
export function isFreshConfirmationRequest(logicalKey) {
  return logicalKey === OUTBOUND_LOGICAL_KEYS.confirmationRequest;
}

export const AMBIGUOUS_CHECK_KEYS = [
  OUTBOUND_LOGICAL_KEYS.confirmationRequest,
  OUTBOUND_LOGICAL_KEYS.reminder1,
  OUTBOUND_LOGICAL_KEYS.reminder2,
  OUTBOUND_LOGICAL_KEYS.confirmationSuccess,
  OUTBOUND_LOGICAL_KEYS.cancellationSuccess,
  OUTBOUND_LOGICAL_KEYS.autoCancellation
];

export function isStaleReservation(outboundMeta, now) {
  if (outboundMeta.state !== SEND_STATE.reserved) {
    return false;
  }
  const reservedAtMs = Date.parse(outboundMeta.reservedAt || '');
  return !Number.isNaN(reservedAtMs) && (now.getTime() - reservedAtMs) >= OUTBOUND_RESERVATION_STALE_MS;
}

export function extractMessageId(sendResult) {
  return sendResult?.id || sendResult?.messageId || sendResult?.data?.id || null;
}

export function hasAmbiguousCustomerOutboundState(order, now = new Date()) {
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

export const reservedSendMethods = {
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
  },

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
    // Exception: the first confirmation request is always sent at once (see isFreshConfirmationRequest).
    if (this.isQuietNow() && !isFreshConfirmationRequest(logicalKey)) {
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
  },

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
};
