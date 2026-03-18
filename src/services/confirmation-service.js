import { formatOrderTotal, interpolateTemplate, normalizePhone, summarizeOrderItems } from '../utils/format.js';

const WORKFLOW_META_KEYS = {
  state: 'rhymat_whatsapp_state',
  confirmationSentAt: 'rhymat_whatsapp_confirmation_sent_at',
  reminderCount: 'rhymat_whatsapp_reminder_count',
  lastReminderAt: 'rhymat_whatsapp_last_reminder_at',
  cancelledAt: 'rhymat_whatsapp_cancelled_at'
};

const PROCESSING_STATUS = 'processing';
const FIRST_REMINDER_MS = 24 * 60 * 60 * 1000;
const SECOND_REMINDER_MS = 48 * 60 * 60 * 1000;
const AUTO_CANCEL_MS = 72 * 60 * 60 * 1000;

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
    if (!inbound.phone || !inbound.text) {
      this.store.recordEvent('wasender', eventKey, payload, 'ignored_non_message');
      return { status: 202, body: { ok: true, ignored: true } };
    }

    const pendingOrder = this.store.findLatestPendingOrderByPhone(inbound.phone);
    this.store.appendMessage({
      source: 'inbound',
      orderId: pendingOrder?.orderId || null,
      phone: inbound.phone,
      kind: 'customer_reply',
      payload,
      text: inbound.text
    });

    if (!pendingOrder) {
      this.store.recordEvent('wasender', eventKey, payload, 'manual_followup_required');
      return { status: 202, body: { ok: false, reason: 'unmatched_reply' } };
    }

    const pendingCount = this.store.listPendingOrdersByPhone(inbound.phone).length;
    if (pendingCount > 1) {
      this.logger.warn(`Multiple pending orders found for ${inbound.phone}; using latest order ${pendingOrder.orderId}.`);
    }

    const reply = inbound.text.trim();
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

    try {
      const statusUpdatedOrder = await this.wooClient.updateOrderStatus(pendingOrder.orderId, nextWooStatus);
      const metaUpdatedOrder = await this.wooClient.updateOrderMeta(
        pendingOrder.orderId,
        buildWorkflowMetaUpdate(statusUpdatedOrder || pendingOrder.rawOrder || {}, {
          state: nextState,
          cancelledAt: reply === '2' ? new Date().toISOString() : ''
        })
      );
      await this.safeAddOrderNote(pendingOrder.orderId, note);
      const followUpMessage = reply === '1'
        ? this.messages.confirmedReply
        : this.messages.cancelledReply;
      await this.safeSendTrackedMessage({
        phone: pendingOrder.phone,
        orderId: pendingOrder.orderId,
        kind: reply === '1' ? 'confirmation_success' : 'cancellation_success',
        message: followUpMessage
      });

      this.store.upsertOrder({
        ...pendingOrder,
        rawOrder: metaUpdatedOrder || statusUpdatedOrder || pendingOrder.rawOrder,
        confirmationState: nextState,
        wooStatus: nextWooStatus,
        finalReply: reply
      });
      this.store.recordEvent('wasender', eventKey, payload, nextState);

      return { status: 202, body: { ok: true, state: nextState } };
    } catch (error) {
      this.store.upsertOrder({
        ...pendingOrder,
        lastError: error.message,
        confirmationState: 'status_update_failed'
      });
      this.store.recordEvent('wasender', eventKey, payload, 'status_update_failed');
      this.logger.error(error);
      return { status: 502, body: { ok: false, reason: 'status_update_failed' } };
    }
  }

  async runOrderFollowups({ now = new Date(), backfillOnly = false } = {}) {
    const summary = {
      backfilled: 0,
      remindersSent: 0,
      autoCancelled: 0,
      skipped: 0,
      errors: 0
    };

    let page = 1;
    const perPage = 100;

    while (true) {
      const orders = await this.wooClient.listOrders({
        status: PROCESSING_STATUS,
        perPage,
        page
      });

      if (!orders.length) {
        break;
      }

      for (const order of orders) {
        const workflow = getWorkflowMeta(order);

        try {
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

      if (orders.length < perPage) {
        break;
      }
      page += 1;
    }

    return summary;
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
        buildWorkflowMetaUpdate(orderPayload, {
          state: 'pending',
          confirmationSentAt: now.toISOString(),
          reminderCount: 0,
          lastReminderAt: '',
          cancelledAt: ''
        })
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
    orderItemsSummary: normalizedOrder.orderItemsSummary,
    deliveryAddress: normalizedOrder.deliveryAddress,
    deliveryCity: normalizedOrder.deliveryCity,
    deliveryEta: normalizedOrder.deliveryEta,
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

  return {
    phone: normalizePhone(candidatePhone),
    text: typeof candidateText === 'string' ? candidateText : ''
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

function extractMessageId(sendResult) {
  return sendResult?.id || sendResult?.messageId || sendResult?.data?.id || null;
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
