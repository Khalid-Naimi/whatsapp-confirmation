import { formatOrderTotal, interpolateTemplate, normalizePhone, summarizeOrderItems } from '../utils/format.js';

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

    const normalizedOrder = normalizeWooOrder(payload, this.messages);
    const existing = this.store.getOrder(normalizedOrder.orderId);
    if (existing?.confirmationState === 'pending_confirmation' || existing?.confirmationState === 'confirmed' || existing?.confirmationState === 'cancelled') {
      this.store.recordEvent('woocommerce', eventKey, payload, 'duplicate_order');
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    if (!normalizedOrder.phone) {
      this.store.upsertOrder({
        ...normalizedOrder,
        confirmationState: 'failed_missing_phone',
        lastError: 'Missing or invalid phone number'
      });
      this.store.recordEvent('woocommerce', eventKey, payload, 'missing_phone');
      return { status: 202, body: { ok: false, reason: 'missing_phone' } };
    }

    const message = interpolateTemplate(this.messages.confirmationTemplate, {
      customerName: normalizedOrder.customerName || 'l3ziz(a)',
      orderId: normalizedOrder.orderId,
      orderTotal: formatOrderTotal(normalizedOrder),
      orderItemsSummary: normalizedOrder.orderItemsSummary,
      deliveryCity: normalizedOrder.deliveryCity,
      deliveryEta: normalizedOrder.deliveryEta,
      storeName: normalizedOrder.storeName || ''
    });

    try {
      const sendResult = await this.wasenderClient.sendMessage({
        to: normalizedOrder.phone,
        message
      });

      this.store.upsertOrder({
        ...normalizedOrder,
        confirmationState: 'pending_confirmation',
        clarificationSent: false,
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
      this.store.recordEvent('woocommerce', eventKey, payload);

      await this.safeAddOrderNote(normalizedOrder.orderId, 'WhatsApp confirmation sent to customer.');

      return { status: 202, body: { ok: true } };
    } catch (error) {
      this.store.upsertOrder({
        ...normalizedOrder,
        confirmationState: 'send_failed',
        lastError: error.message
      });
      this.store.recordEvent('woocommerce', eventKey, payload, 'send_failed');
      this.logger.error(error);
      return { status: 502, body: { ok: false, reason: 'send_failed' } };
    }
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
      if (!pendingOrder.clarificationSent) {
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
            clarificationSent: true,
            confirmationState: 'pending_confirmation'
          });
        } catch (error) {
          this.logger.error(error);
          this.store.upsertOrder({
            ...pendingOrder,
            lastError: error.message
          });
        }
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
      await this.wooClient.updateOrderStatus(pendingOrder.orderId, nextWooStatus);
      await this.safeAddOrderNote(pendingOrder.orderId, note);
      const followUpMessage = reply === '1'
        ? this.messages.confirmedReply
        : this.messages.cancelledReply;
      const followUpResult = await this.wasenderClient.sendMessage({
        to: pendingOrder.phone,
        message: followUpMessage
      });
      this.store.appendMessage({
        source: 'outbound',
        orderId: pendingOrder.orderId,
        phone: pendingOrder.phone,
        kind: reply === '1' ? 'confirmation_success' : 'cancellation_success',
        payload: followUpResult,
        text: followUpMessage
      });

      this.store.upsertOrder({
        ...pendingOrder,
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

  async safeAddOrderNote(orderId, note) {
    try {
      await this.wooClient.addOrderNote(orderId, note);
    } catch (error) {
      this.logger.warn(`Unable to add WooCommerce note for order ${orderId}: ${error.message}`);
    }
  }
}

function normalizeWooOrder(payload, messages) {
  const billing = payload.billing || {};
  const shipping = payload.shipping || {};
  const billingState = String(billing.state || payload.billing_state || '').trim();
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
    deliveryCity,
    deliveryEta: resolveDeliveryEta(resolvedCity, messages),
    lineItems,
    orderItemsSummary: summarizeOrderItems(lineItems),
    wooStatus: payload.status || 'pending',
    rawOrder: payload
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
