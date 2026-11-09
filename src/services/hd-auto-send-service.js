import { HighDeliveryError } from './highdelivery-client.js';
import { formatOrderTotal, interpolateTemplate, summarizeOrderItems } from '../utils/format.js';

// Woo order meta written by the auto-send. The state doubles as the "never send twice" guard.
export const HD_META = {
  state: 'rhymat_hd_api_state', // sending | sent | failed | unknown
  tracking: 'rhymat_hd_api_tracking',
  sentAt: 'rhymat_hd_api_sent_at',
  error: 'rhymat_hd_api_error'
};

const BLOCKING_STATES = new Set(['sending', 'sent', 'unknown']);

function metaValue(order, key) {
  const row = (order?.meta_data || []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

// Moroccan mobile/landline as HighDelivery wants it: 0XXXXXXXXX. Anything else is left for the desktop app.
export function normalizeMoroccanPhone(value) {
  let digits = String(value || '').replace(/\D/gu, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('212') && digits.length === 12) {
    digits = `0${digits.slice(3)}`;
  } else if (digits.length === 9 && /^[5-7]/u.test(digits)) {
    digits = `0${digits}`;
  }
  return /^0[5-7]\d{8}$/u.test(digits) ? digits : '';
}

export function buildParcelFromWooOrder(order) {
  const shipping = order?.shipping || {};
  const billing = order?.billing || {};
  const pick = (...values) => values.map((value) => String(value || '').trim()).find(Boolean) || '';

  const recipientName = pick(
    `${shipping.first_name || ''} ${shipping.last_name || ''}`,
    `${billing.first_name || ''} ${billing.last_name || ''}`
  ) || 'Client';
  const rawPhone = pick(shipping.phone, billing.phone);
  const recipientPhone = normalizeMoroccanPhone(rawPhone);
  const city = pick(shipping.city, billing.city, shipping.state, billing.state);
  const address = pick(
    [shipping.address_1, shipping.address_2].filter(Boolean).join(', '),
    [billing.address_1, billing.address_2].filter(Boolean).join(', ')
  );
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const productName = lineItems
    .map((item) => {
      const name = String(item?.name || '').trim();
      const quantity = Number(item?.quantity || 0);
      return name && quantity > 0 ? `${name} x${quantity}` : '';
    })
    .filter(Boolean)
    .join(', ');
  const codAmount = Math.round(Number(order?.total));

  const problems = [];
  if (!recipientPhone) {
    problems.push(rawPhone ? 'the phone number is not a Moroccan number HighDelivery accepts' : 'the phone number is missing');
  }
  if (!city) {
    problems.push('the city is missing');
  }
  if (!address) {
    problems.push('the address is missing');
  }
  if (!productName) {
    problems.push('the order has no items');
  }
  if (!Number.isFinite(codAmount) || codAmount <= 0) {
    problems.push('the order total is not a positive amount');
  }

  return {
    ok: problems.length === 0,
    problems,
    parcel: { recipientName, recipientPhone, address, city, productName, codAmount, comment: `Woo #${order?.id ?? ''}`.trim() }
  };
}

export class HdAutoSendService {
  constructor({ hdClient, wooClient, wasenderClient, store, notifyPhones = [], template = '', enabled = false, logger = console }) {
    this.hdClient = hdClient;
    this.wooClient = wooClient;
    this.wasenderClient = wasenderClient;
    this.store = store;
    this.notifyPhones = notifyPhones;
    this.template = template;
    this.enabled = Boolean(enabled);
    this.logger = logger;
    this.inFlight = new Set();
  }

  // Sends one confirmed order to HighDelivery. Never throws: whatever happens, the order is either completed in Woo
  // (sent) or left exactly as it is (on-hold) so the desktop app still picks it up.
  async autoSend(order) {
    if (!this.enabled) {
      return { status: 'disabled' };
    }
    const orderId = String(order?.orderId ?? '');
    if (!orderId) {
      return { status: 'skipped', reason: 'missing_order_id' };
    }
    if (this.inFlight.has(orderId)) {
      return { status: 'skipped', reason: 'already_running' };
    }
    this.inFlight.add(orderId);
    try {
      return await this.run(orderId, order);
    } catch (error) {
      this.logger.warn(`[hd-auto-send] unexpected error orderId=${orderId}: ${error.message}`);
      return { status: 'error', error: error.message };
    } finally {
      this.inFlight.delete(orderId);
    }
  }

  async run(orderId, order) {
    if (!this.hdClient?.isConfigured()) {
      this.logger.warn(`[hd-auto-send] skipped orderId=${orderId} reason=not_configured`);
      return { status: 'skipped', reason: 'not_configured' };
    }

    let raw;
    try {
      raw = await this.wooClient.getOrder(orderId);
    } catch (error) {
      this.logger.warn(`[hd-auto-send] skipped orderId=${orderId} reason=woo_read_failed ${error.message}`);
      return { status: 'skipped', reason: 'woo_read_failed' };
    }

    const previousState = metaValue(raw, HD_META.state);
    if (BLOCKING_STATES.has(previousState)) {
      this.logger.log(`[hd-auto-send] skipped orderId=${orderId} reason=already_${previousState}`);
      return { status: 'skipped', reason: `already_${previousState}` };
    }
    if (raw?.status && raw.status !== 'on-hold') {
      // Someone already handled it (completed, cancelled, ...): do not touch it.
      this.logger.log(`[hd-auto-send] skipped orderId=${orderId} reason=status_${raw.status}`);
      return { status: 'skipped', reason: `status_${raw.status}` };
    }

    // Fresh Woo data wins; the order as the webhook delivered it fills any field Woo's answer does not carry.
    const full = { ...(order?.rawOrder || {}), ...raw };
    const built = buildParcelFromWooOrder(full);
    if (!built.ok) {
      const reason = built.problems.join('; ');
      await this.note(orderId, `Auto-send to HighDelivery skipped: ${reason}. The order stays on-hold; send it from the desktop app.`);
      return { status: 'skipped', reason: 'invalid_order', detail: reason };
    }

    // Reserve first: if we cannot record that we are sending, we must not send (a retry could create a second parcel).
    try {
      await this.wooClient.updateOrderMeta(orderId, [
        { key: HD_META.state, value: 'sending' },
        { key: HD_META.error, value: '' }
      ]);
    } catch (error) {
      this.logger.warn(`[hd-auto-send] skipped orderId=${orderId} reason=reservation_failed ${error.message}`);
      return { status: 'skipped', reason: 'reservation_failed' };
    }

    let result;
    try {
      result = await this.hdClient.createPackage(built.parcel);
    } catch (error) {
      const detail = error instanceof HighDeliveryError ? error.detail() : error.message;
      const ambiguous = Boolean(error?.ambiguous);
      const state = ambiguous ? 'unknown' : 'failed';
      this.logger.warn(`[hd-auto-send] ${state} orderId=${orderId} ${detail}`);
      await this.safe(() => this.wooClient.updateOrderMeta(orderId, [
        { key: HD_META.state, value: state },
        { key: HD_META.error, value: detail.slice(0, 500) }
      ]));
      await this.note(
        orderId,
        ambiguous
          ? `Auto-send to HighDelivery got no answer (${detail}). The parcel may exist: check HighDelivery before sending this order again from the desktop app.`
          : `Auto-send to HighDelivery failed: ${detail}. The order stays on-hold; send it from the desktop app.`
      );
      return { status: state, error: detail };
    }

    const tracking = result.trackingNumber || '';
    const sentAt = new Date().toISOString();
    await this.safe(() => this.wooClient.updateOrderMeta(orderId, [
      { key: HD_META.state, value: 'sent' },
      { key: HD_META.tracking, value: tracking },
      { key: HD_META.sentAt, value: sentAt },
      { key: HD_META.error, value: '' }
    ]));
    this.store?.upsertOrder?.({ ...(order || {}), orderId, hdAutoSentAt: sentAt, hdTrackingNumber: tracking });
    await this.note(orderId, `Sent to HighDelivery automatically${tracking ? `. Tracking: ${tracking}` : ''}.`);

    let completed = true;
    try {
      await this.wooClient.updateOrderStatus(orderId, 'completed');
    } catch (error) {
      completed = false;
      this.logger.warn(`[hd-auto-send] parcel sent but Woo status update failed orderId=${orderId} ${error.message}`);
      await this.note(orderId, `Sent to HighDelivery, but WooCommerce could not be set to completed (${error.message}). Complete it manually; do not send it again.`);
    }

    const notified = await this.notify(orderId, full, tracking);
    return { status: 'sent', trackingNumber: tracking, completed, notified };
  }

  async notify(orderId, raw, tracking) {
    const values = {
      customerName: [raw?.shipping?.first_name, raw?.shipping?.last_name].filter(Boolean).join(' ')
        || [raw?.billing?.first_name, raw?.billing?.last_name].filter(Boolean).join(' ')
        || 'Client',
      orderId,
      trackingNumber: tracking || '—',
      customerPhone: raw?.shipping?.phone || raw?.billing?.phone || '',
      deliveryCity: raw?.shipping?.city || raw?.billing?.city || '',
      deliveryAddress: [raw?.shipping?.address_1, raw?.shipping?.address_2].filter(Boolean).join(', ')
        || [raw?.billing?.address_1, raw?.billing?.address_2].filter(Boolean).join(', '),
      orderItemsSummary: summarizeOrderItems(raw?.line_items || []),
      orderTotal: formatOrderTotal(raw || {})
    };
    const message = interpolateTemplate(this.template, values);
    let sentTo = 0;
    for (const phone of this.notifyPhones || []) {
      try {
        const sent = await this.wasenderClient.sendMessage({ to: phone, message });
        sentTo += 1;
        this.store?.appendMessage?.({
          source: 'outbound',
          orderId,
          phone,
          kind: 'internal_hd_sent_notification',
          payload: sent,
          text: message
        });
      } catch (error) {
        this.logger.warn(`[hd-auto-send] could not notify ${phone} about order ${orderId}: ${error.message}`);
      }
    }
    return sentTo;
  }

  async note(orderId, text) {
    await this.safe(() => this.wooClient.addOrderNote(orderId, text));
  }

  async safe(work) {
    try {
      return await work();
    } catch (error) {
      this.logger.warn(`[hd-auto-send] side effect failed: ${error.message}`);
      return null;
    }
  }
}
