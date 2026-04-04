import { formatOrderTotal, interpolateTemplate, normalizePhone, summarizeOrderItems } from '../utils/format.js';

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
  internalNotifiedConfirmed: 'rhymat_whatsapp_internal_notified_confirmed',
  internalNotifiedCancelled: 'rhymat_whatsapp_internal_notified_cancelled',
  manualOverride: 'rhymat_whatsapp_manual_override',
  manualOverrideAt: 'rhymat_whatsapp_manual_override_at',
  manualOverrideStatus: 'rhymat_whatsapp_manual_override_status'
};

const PROCESSING_STATUS = 'processing';
const RECONCILIATION_STATUSES = ['pending', 'processing', 'on-hold', 'cancelled', 'completed', 'failed', 'refunded'];
const REPLY_RECOVERY_STATUSES = ['pending', 'processing', 'on-hold', 'cancelled'];
const FIRST_REMINDER_MS = 24 * 60 * 60 * 1000;
const SECOND_REMINDER_MS = 48 * 60 * 60 * 1000;
const AUTO_CANCEL_MS = 72 * 60 * 60 * 1000;
const MAX_WOO_SYNC_ATTEMPTS = 6;

export class ConfirmationService {
  constructor({ store, wasenderClient, wooClient, messages, logger = console }) {
    this.store = store;
    this.wasenderClient = wasenderClient;
    this.wooClient = wooClient;
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
    this.store.recordEvent('woocommerce', eventKey, payload, result.body.ok ? 'processed' : result.body.reason);
    return result;
  }

  async processWasenderInbound(payload, eventKey) {
    if (this.store.hasProcessedEvent('wasender', eventKey)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    const inbound = normalizeWasenderInbound(payload);
    if (!inbound.phone || (!inbound.text && inbound.type !== 'audio')) {
      this.store.recordEvent('wasender', eventKey, payload, 'ignored_non_message');
      return { status: 202, body: { ok: true, ignored: true } };
    }

    const replyContext = await this.resolveReplyContext(inbound.phone);
    const pendingOrder = replyContext.pendingOrder;
    const latestOrder = replyContext.latestOrder;
    this.store.appendMessage({
      source: 'inbound',
      orderId: latestOrder?.orderId || null,
      phone: inbound.phone,
      kind: inbound.type === 'audio' ? 'customer_audio_reply' : 'customer_reply',
      payload,
      text: inbound.text
    });

    if (!pendingOrder) {
      if (latestOrder && isSameFinalDecision(latestOrder, inbound)) {
        this.store.recordEvent('wasender', eventKey, payload, 'duplicate_final_reply');
        return { status: 200, body: { ok: true, duplicate: true } };
      }
      this.store.recordEvent('wasender', eventKey, payload, 'manual_followup_required');
      return { status: 202, body: { ok: false, reason: 'unmatched_reply' } };
    }

    const pendingCount = this.store.listPendingOrdersByPhone(inbound.phone).length;
    if (pendingCount > 1) {
      this.logger.warn(`Multiple pending orders found for ${inbound.phone}; using latest order ${pendingOrder.orderId}.`);
    }

    const reply = inbound.type === 'audio' ? '' : inbound.text.trim();
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
        this.store.recordEvent('wasender', eventKey, payload, 'manual_followup_required');
        return { status: 202, body: { ok: false, reason: 'manual_followup_required' } };
      }

      this.store.recordEvent('wasender', eventKey, payload, 'invalid_reply');
      return { status: 202, body: { ok: false, reason: 'invalid_reply' } };
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
    const workflow = getWorkflowMeta(pendingOrder.rawOrder || {});
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
      this.store.recordEvent('wasender', eventKey, payload, reconciliation.success ? 'duplicate_final_reply' : reconciliation.syncStatus);
      return { status: 200, body: { ok: true, duplicate: true } };
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
    const eventStatus = replyContext.matchedViaWooFallback
      ? 'matched_via_woo_fallback'
      : reconciliation.success
        ? nextState
        : reconciliation.syncStatus;
    this.store.recordEvent('wasender', eventKey, payload, eventStatus);

    return {
      status: 202,
      body: {
        ok: true,
        state: nextState,
        wooSyncStatus: reconciliation.syncStatus
      }
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
    if (!normalizedOrder.phone) {
      this.store.upsertOrder({
        ...normalizedOrder,
        confirmationState: 'failed_missing_phone',
        lastError: 'Missing or invalid phone number'
      });
      return { status: 202, body: { ok: false, reason: 'missing_phone' } };
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

      return { status: 202, body: { ok: true } };
    } catch (error) {
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
      const statusUpdatedOrder = await this.wooClient.updateOrderStatus(order.orderId, targetWooStatus);
      rawOrder = statusUpdatedOrder || rawOrder;
      const metaUpdatedOrder = await this.persistDecisionMeta({
        orderPayload: rawOrder,
        orderId: order.orderId,
        state: targetState,
        nowIso,
        customerReplySent: order.customerReplySent || 'no',
        wooSyncStatus: 'synced',
        wooSyncAttempts: attemptNumber,
        lastSyncError: ''
      });
      rawOrder = metaUpdatedOrder || rawOrder;
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
    manualOverride: workflowView.manualOverride,
    manualOverrideAt: workflowView.manualOverrideAt,
    manualOverrideStatus: workflowView.manualOverrideStatus,
    invalidReplyCount: Number(localOrder?.invalidReplyCount || 0),
    manualFollowupRequired: Boolean(localOrder?.manualFollowupRequired),
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

function normalizeWasenderInbound(payload) {
  const messages = extractWasenderMessages(payload);
  const primaryMessage = messages[0] || {};
  const messageKey = primaryMessage.key || {};
  const messageNode = primaryMessage.message || {};

  if (messageKey.fromMe || primaryMessage.fromMe) {
    return {
      phone: '',
      text: ''
    };
  }

  const candidatePhone =
    messageKey.cleanedSenderPn ||
    messageKey.senderPn ||
    normalizeRemoteJid(messageKey.remoteJid) ||
    payload.from ||
    payload.sender ||
    payload.senderPhone ||
    payload.phone ||
    payload.data?.from ||
    payload.data?.sender ||
    payload.data?.senderPhone ||
    payload.message?.from;

  const candidateText =
    primaryMessage.messageBody ||
    messageNode.conversation ||
    messageNode.extendedTextMessage?.text ||
    payload.text ||
    payload.message ||
    payload.body ||
    payload.data?.text ||
    payload.data?.body ||
    payload.message?.text;

  const messageType = detectWasenderMessageType(primaryMessage, messageNode);

  return {
    phone: normalizePhone(candidatePhone),
    text: typeof candidateText === 'string' ? candidateText : '',
    type: messageType
  };
}

function extractWasenderMessages(payload) {
  const candidate = payload.data?.messages;
  if (Array.isArray(candidate)) {
    return candidate;
  }
  if (candidate && typeof candidate === 'object') {
    return [candidate];
  }
  return [];
}

function normalizeRemoteJid(remoteJid) {
  if (!remoteJid || typeof remoteJid !== 'string') {
    return '';
  }

  return remoteJid.split('@')[0];
}

function detectWasenderMessageType(primaryMessage, messageNode) {
  if (
    primaryMessage.audio ||
    messageNode.audioMessage ||
    messageNode.ptt
  ) {
    return 'audio';
  }

  return 'text';
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
    internalNotifiedConfirmed: String(metaValue(DECISION_META_KEYS.internalNotifiedConfirmed) || ''),
    internalNotifiedCancelled: String(metaValue(DECISION_META_KEYS.internalNotifiedCancelled) || ''),
    manualOverride: String(metaValue(DECISION_META_KEYS.manualOverride) || ''),
    manualOverrideAt: String(metaValue(DECISION_META_KEYS.manualOverrideAt) || ''),
    manualOverrideStatus: String(metaValue(DECISION_META_KEYS.manualOverrideStatus) || '')
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

function mergeMetaUpdates(...metaSets) {
  const merged = new Map();
  for (const metaSet of metaSets) {
    for (const item of metaSet) {
      merged.set(item.key, item);
    }
  }
  return [...merged.values()];
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
