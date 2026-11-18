// The hourly follow-ups (POST /tasks/order-followups): backfill of first messages, the two reminders, the auto-cancel,
// decisions whose Woo write failed, the one-time HighDelivery retry and stuck sends. Every customer step re-reads
// the order first. Methods run with the ConfirmationService as `this`. Moved unchanged out of confirmation-service.js.

import { HD_META, HD_PARCEL_TRACE_META, OUTBOUND_LOGICAL_KEYS, OUTBOUND_META_KEYS } from '../../domain/order-meta.js';
import {
  ACTIVE_CONFIRMATION_STATUSES,
  DECISION,
  FOLLOWUP_CLOSED_STATUSES,
  HD_STATE,
  RECONCILIATION_STATUSES,
  SEND_STATE,
  WOO_STATUS,
  WOO_SYNC_STATUS,
  WORKFLOW_STATE
} from '../../domain/order-states.js';
import { interpolateTemplate, maskPhone } from '../../utils/format.js';
import { wooStatusMatchesTarget } from '../../utils/hd-status.js';
import {
  buildDecisionMetaUpdate,
  buildLogicalSendMetaUpdate,
  buildTemplateValues,
  buildWorkflowMetaUpdate,
  getDecisionMeta,
  getFeedbackMeta,
  getOutboundReservationMeta,
  getWorkflowMeta,
  isConfirmationAlreadyStarted,
  isExpectedStatusForDecision,
  isFeedbackSelfTestOrder,
  mergeMetaUpdates,
  normalizeWooOrder
} from './order-helpers.js';
import { hasAmbiguousCustomerOutboundState } from './outbound/reserved-send.js';

export const BACKFILL_MAX_ORDER_AGE_MS = 72 * 60 * 60 * 1000;

// Reminder 2 never goes out less than this after reminder 1, even when reminder 1 itself was late.
export const MIN_GAP_BETWEEN_REMINDERS_MS = 20 * 60 * 60 * 1000;

// A second order from the same phone placed within this time of an older still-open one is a double order.
export const DOUBLE_ORDER_WINDOW_MS = 6 * 60 * 60 * 1000;

export const FIRST_REMINDER_MS = 24 * 60 * 60 * 1000;

export const SECOND_REMINDER_MS = 48 * 60 * 60 * 1000;

export const AUTO_CANCEL_AFTER_SECOND_REMINDER_MS = 24 * 60 * 60 * 1000;

export const HD_RETRY_META = HD_META.retryAt;

export const HD_STATE_META = HD_META.state;

export const HD_RETRY_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export function readOrderMeta(order, key) {
  const row = (Array.isArray(order?.meta_data) ? order.meta_data : []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

export function getHdAutoSendState(order) {
  return readOrderMeta(order, HD_STATE_META);
}

// What the hourly task decided on: if any of it changed between the listing and the action, the action is skipped.
export function followupSignature(order) {
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
export function isTransientWooError(error) {
  const message = String(error?.message || '');
  const status = message.match(/failed with (\d{3})/u);
  if (status) {
    const code = Number(status[1]);
    return code === 429 || code >= 500;
  }
  return ['TimeoutError', 'AbortError'].includes(error?.name) || /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket|terminated|timed? ?out/iu.test(message);
}

export function isOrderOlderThan(order, now, maxAgeMs) {
  const raw = String(order?.date_created_gmt || '').trim();
  if (!raw) {
    return false;
  }

  const createdAtMs = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw) ? raw : `${raw}Z`);
  return !Number.isNaN(createdAtMs) && (now.getTime() - createdAtMs) > maxAgeMs;
}

function orderCreatedMs(order) {
  const raw = String(order?.date_created_gmt || '').trim();
  if (!raw) {
    return NaN;
  }
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw) ? raw : `${raw}Z`);
}

// The older orders of a double order: still waiting for an answer while the same phone placed a newer, not cancelled order
// within a few hours. The customer's answer goes to the newest order, so the older one gets no reminder and no
// auto-cancel message (they would contradict the answer); the team was told when the customer answered. If the newer
// order is cancelled, the older one is no longer in this set and its reminders carry on as usual.
export function findSupersededOrderIds(orders, messages) {
  const byPhone = new Map();
  for (const order of orders) {
    const phone = normalizeWooOrder(order, messages).phone;
    if (!phone) {
      continue;
    }
    const list = byPhone.get(phone) || [];
    list.push(order);
    byPhone.set(phone, list);
  }
  const superseded = new Set();
  for (const list of byPhone.values()) {
    if (list.length < 2) {
      continue;
    }
    for (const older of list) {
      const olderDecision = getDecisionMeta(older);
      if (getWorkflowMeta(older).state !== WORKFLOW_STATE.pending
        || !ACTIVE_CONFIRMATION_STATUSES.includes(String(older.status || ''))
        || olderDecision.decision
        || olderDecision.manualOverride === 'yes') {
        continue;
      }
      const olderMs = orderCreatedMs(older);
      const hasNewer = list.some((newer) => {
        if (newer === older || String(newer.status || '') === 'cancelled' || getWorkflowMeta(newer).state === WORKFLOW_STATE.cancelled) {
          return false;
        }
        // The newer order must still be waiting, or be one the customer decided: an order the team handled by hand
        // says nothing about the older one, which then goes on with its own reminders.
        if (getWorkflowMeta(newer).state !== WORKFLOW_STATE.pending && !getDecisionMeta(newer).decision) {
          return false;
        }
        const newerMs = orderCreatedMs(newer);
        if (!Number.isNaN(olderMs) && !Number.isNaN(newerMs)) {
          return newerMs > olderMs && (newerMs - olderMs) <= DOUBLE_ORDER_WINDOW_MS;
        }
        return Number(newer.id) > Number(older.id);
      });
      if (hasNewer) {
        superseded.add(String(older.id));
      }
    }
  }
  return superseded;
}

export const followupMethods = {
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
      ...await this.withTransientRetry(() => this.listOrdersForStatuses(RECONCILIATION_STATUSES.filter((status) => !closedStatuses.includes(status))), 'open order list', { idempotent: true, clientRetries: true }),
      ...await this.withTransientRetry(() => this.listOrdersForStatuses(closedStatuses, { after: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString() }), 'closed order list', { idempotent: true, clientRetries: true })
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

    const supersededOrderIds = findSupersededOrderIds(orders, this.messages);

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

          if (supersededOrderIds.has(orderId)) {
            this.logFollowupDecision({
              orderId,
              orderStatus: order.status,
              workflowState: workflow.state,
              confirmationSentAt: workflow.confirmationSentAt,
              reminderCount: workflow.reminderCount,
              action: 'skip_superseded_by_newer_order'
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

          const lastReminderMs = Date.parse(workflow.reminder1SentAt || workflow.lastReminderAt || '');
          const reminderGapOk = Number.isNaN(lastReminderMs) || (now.getTime() - lastReminderMs) >= MIN_GAP_BETWEEN_REMINDERS_MS;

          if (ageMs >= SECOND_REMINDER_MS && workflow.reminderCount === 1 && reminderGapOk) {
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
              if (this.isQuietNow()) {
                // The cancel message cannot go out at night, so the order is not cancelled now either: the next run after the window does both.
                this.logger.log(`[quiet-hours] auto-cancel waits for the morning orderId=${orderId}`);
                return 'skipped';
              }
              if (!await stillSame()) {
                return 'skipped';
              }
              await this.autoCancelPendingOrder(order, now);
              await this.cancelSupersededSiblings(order, orders, supersededOrderIds, now);
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
  },

  logFollowupDecision({ orderId, orderStatus, workflowState, confirmationSentAt, reminderCount, ageMs = null, action }) {
    const ageHours = Number.isFinite(ageMs) ? (ageMs / (60 * 60 * 1000)).toFixed(2) : 'n/a';
    this.logger.log(
      `[task][order-followups] orderId=${orderId} status=${String(orderStatus || '')} workflowState=${String(workflowState || '')} confirmationSentAt=${String(confirmationSentAt || '')} reminderCount=${Number(reminderCount || 0)} ageHours=${ageHours} action=${action}`
    );
  },

  // Retries a WooCommerce call that failed for a passing reason (timeout, network, 429, 5xx); anything else is thrown.
  // Only work the caller marks idempotent (a read, an absolute meta write) is retried here: anything else (an order
  // note, a create) gets a single attempt, since a "failed" call may have landed and a repeat would duplicate it.
  // Work the WooCommerce client already retries (every GET: the order lists, an order read) gets a single attempt here
  // too ({ clientRetries: true }): stacking both layers could keep one hourly step retrying for minutes.
  async withTransientRetry(work, label, options = {}) {
    const { attempts: maxAttempts = 3, idempotent = false, clientRetries = false } = typeof options === 'number' ? { attempts: options, idempotent: true } : options;
    const attempts = idempotent && !clientRetries ? maxAttempts : 1;
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
  },

  // The order as WooCommerce has it now, or null when it cannot be read (the step is then skipped this hour).
  async rereadForFollowup(orderId, listedOrder) {
    if (typeof this.wooClient.getOrder !== 'function') {
      return listedOrder;
    }
    try {
      return (await this.withTransientRetry(() => this.wooClient.getOrder(orderId), `order ${orderId}`, { idempotent: true, clientRetries: true })) || null;
    } catch (error) {
      this.logger.warn(`[task][order-followups] could not re-read orderId=${orderId}: ${error.message}`);
      return null;
    }
  },

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
  },

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
  },

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
  },

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
  },

  // The customer never answered any of a double order: when the newest is auto-cancelled, its older twins (which got no
  // reminders of their own) are cancelled with it, silently: one "cancelled" message was already sent for the newest.
  async cancelSupersededSiblings(cancelledOrder, orders, supersededOrderIds, now, visited = new Set()) {
    visited.add(String(cancelledOrder.id));
    const phone = normalizeWooOrder(cancelledOrder, this.messages).phone;
    const cancelledMs = orderCreatedMs(cancelledOrder);
    for (const sibling of orders) {
      const siblingId = String(sibling.id);
      if (visited.has(siblingId) || !supersededOrderIds.has(siblingId)) {
        continue;
      }
      const siblingMs = orderCreatedMs(sibling);
      const isOlderTwin = !Number.isNaN(siblingMs) && !Number.isNaN(cancelledMs)
        ? siblingMs < cancelledMs && (cancelledMs - siblingMs) <= DOUBLE_ORDER_WINDOW_MS
        : Number(sibling.id) < Number(cancelledOrder.id);
      if (!isOlderTwin || normalizeWooOrder(sibling, this.messages).phone !== phone) {
        continue;
      }
      let cancelledNow = false;
      try {
        await this.withOrderLock(siblingId, async () => {
          const fresh = typeof this.wooClient.getOrder === 'function' ? await this.wooClient.getOrder(siblingId) : sibling;
          const freshDecision = getDecisionMeta(fresh);
          if (getWorkflowMeta(fresh).state !== WORKFLOW_STATE.pending
            || !ACTIVE_CONFIRMATION_STATUSES.includes(String(fresh?.status || ''))
            || freshDecision.decision
            || freshDecision.manualOverride === 'yes') {
            return;
          }
          cancelledNow = true;
          const nowIso = now.toISOString();
          const statusUpdated = await this.wooClient.updateOrderStatus(siblingId, WOO_STATUS.cancelled);
          await this.wooClient.updateOrderMeta(
            siblingId,
            mergeMetaUpdates(
              buildWorkflowMetaUpdate(statusUpdated || fresh, { state: WORKFLOW_STATE.cancelled, cancelledAt: nowIso }),
              buildDecisionMetaUpdate(statusUpdated || fresh, {
                decision: DECISION.cancelled,
                decisionAt: nowIso,
                wooSyncStatus: WOO_SYNC_STATUS.synced,
                wooSyncAttempts: 0,
                lastSyncError: '',
                customerReplySent: 'no'
              })
            )
          );
          await this.safeAddOrderNote(siblingId, `Cancelled with its newer double order #${cancelledOrder.id}, which the customer never answered (no message sent for this one).`);
          this.logger.log(`[task][order-followups] older double order cancelled with its twin orderId=${siblingId} twin=${cancelledOrder.id}`);
        });
      } catch (error) {
        this.logger.warn(`[task][order-followups] could not cancel older double order orderId=${siblingId}: ${error.message}`);
      }
      if (cancelledNow) {
        // A chain of three double orders: the one just cancelled takes its own older twin with it.
        await this.cancelSupersededSiblings(sibling, orders, supersededOrderIds, now, visited);
      }
    }
  },

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
};
