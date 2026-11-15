import { HighDeliveryError } from './highdelivery-client.js';
import { isConfirmedWooStatus } from '../utils/hd-status.js';
import { formatOrderTotal, interpolateTemplate, maskPhone, summarizeOrderItems } from '../utils/format.js';
import { describeItems, resolveWarehouseItems } from './hd-product-match.js';
import { buildUnitLookup, describeResolution, resolveOrderItems, sameResolution } from './order-resolver.js';

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
  // The customer picked the fast delivery at checkout: the parcel goes express (the total already includes its price).
  // The website tags every delivery choice (rhymat_delivery = standard | fast | casa). Only "fast" is express at HighDelivery:
  // Casablanca "le jour même" is HighDelivery's standard Casablanca delivery. Older orders carry no tag, so "express" in the title still counts.
  const shippingLines = Array.isArray(order?.shipping_lines) ? order.shipping_lines : [];
  const tagOf = (line) => (line?.meta_data || []).find((meta) => meta?.key === 'rhymat_delivery')?.value;
  const isExpress = shippingLines.some((line) => {
    const tag = tagOf(line);
    return tag ? tag === 'fast' : /express/iu.test(`${line?.method_title || ''}`);
  });

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
    parcel: { recipientName, recipientPhone, address, city, productName, codAmount, isExpress, comment: `Woo #${order?.id ?? ''}`.trim() }
  };
}

export class HdAutoSendService {
  constructor({ hdClient, wooClient, wasenderClient, store, notifyPhones = [], template = '', manualTemplate = '', errorTemplate = '', enabled = false, productMap = null, linkIndex = null, linksMode = 'off', minTrustScore = 30, logger = console }) {
    this.hdClient = hdClient;
    this.wooClient = wooClient;
    this.wasenderClient = wasenderClient;
    this.store = store;
    this.notifyPhones = notifyPhones;
    this.template = template;
    this.manualTemplate = manualTemplate; // order needs a human (held, no stock match, bad data)
    this.errorTemplate = errorTemplate; // the send failed or the answer is unknown
    this.enabled = Boolean(enabled);
    this.productMap = productMap; // Woo product name -> HighDelivery warehouse products (see hd-product-match.js)
    this.linkIndex = linkIndex; // product link documents read from WooCommerce (see link-index.js)
    this.linksMode = linksMode; // off | shadow | on (HD_LINKS_FOR_ORDERS)
    this.minTrustScore = Number.isFinite(Number(minTrustScore)) ? Number(minTrustScore) : 30;
    this.logger = logger;
    this.inFlight = new Set();
  }

  // Sends one confirmed order to HighDelivery. Never throws: whatever happens, the order is either completed in Woo
  // (sent) or left exactly as it is (confirmed / on-hold) so the desktop app still picks it up.
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
      const context = {};
      const outcome = await this.run(orderId, order, context);
      this.rememberOutcome(orderId, outcome);
      await this.notifyProblem(orderId, context.raw || order, outcome);
      return outcome;
    } catch (error) {
      this.logger.warn(`[hd-auto-send] unexpected error orderId=${orderId}: ${error.message}`);
      const outcome = { status: 'error', error: error.message };
      this.rememberOutcome(orderId, outcome);
      await this.notifyProblem(orderId, order, outcome);
      return outcome;
    } finally {
      this.inFlight.delete(orderId);
    }
  }

  // Keeps the last result on the stored order so the health page can list what needs a human. Never throws.
  rememberOutcome(orderId, outcome) {
    try {
      if (!this.store?.getOrder?.(orderId)) {
        return;
      }
      this.store.upsertOrder({
        orderId,
        hdOutcome: String(outcome?.status || ''),
        hdOutcomeReason: String(outcome?.reason || ''),
        hdOutcomeAt: new Date().toISOString()
      });
    } catch (error) {
      this.logger.warn(`[hd-auto-send] could not remember the outcome for order ${orderId}: ${error.message}`);
    }
  }

  async run(orderId, order, context = {}) {
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
    if (raw?.status && !isConfirmedWooStatus(raw.status)) {
      // Someone already handled it (completed, cancelled, ...): do not touch it.
      this.logger.log(`[hd-auto-send] skipped orderId=${orderId} reason=status_${raw.status}`);
      return { status: 'skipped', reason: `status_${raw.status}` };
    }

    // Fresh Woo data wins; the order as the webhook delivered it fills any field Woo's answer does not carry.
    const full = { ...(order?.rawOrder || {}), ...raw };
    context.raw = full;
    const built = buildParcelFromWooOrder(full);
    if (!built.ok) {
      const reason = built.problems.join('; ');
      await this.note(orderId, `Auto-send to HighDelivery skipped: ${reason}. The order stays on-hold; send it from the desktop app.`);
      return { status: 'skipped', reason: 'invalid_order', detail: reason };
    }

    // Which warehouse products and quantities does this order take? Without a match the platform refuses the parcel.
    const parcel = { ...built.parcel };
    if (this.productMap) {
      let matched;
      try {
        matched = await this.matchItems(orderId, full);
      } catch (error) {
        const detail = error instanceof HighDeliveryError ? error.detail() : error.message;
        this.logger.warn(`[hd-auto-send] skipped orderId=${orderId} reason=stock_read_failed ${detail}`);
        await this.note(orderId, `Auto-send to HighDelivery skipped: could not read the warehouse stock (${detail}). The order stays on-hold; send it from the desktop app.`);
        return { status: 'skipped', reason: 'stock_read_failed', detail };
      }
      if (!matched.ok) {
        const reason = matched.problems.join('; ');
        await this.note(orderId, `Auto-send to HighDelivery skipped: ${reason}. The order stays on-hold; send it from the desktop app.`);
        return { status: 'skipped', reason: 'no_warehouse_match', detail: reason };
      }
      parcel.items = matched.items;
      parcel.productName = describeItems(matched.items);
    }

    // The platform's own check of the customer's number. A blacklisted or low-scoring number is held for a human.
    let trust = null;
    try {
      trust = await this.hdClient.trustScore(parcel.recipientPhone);
    } catch (error) {
      // The check must never block a good order: log it and carry on.
      this.logger.warn(`[hd-auto-send] trust check unavailable orderId=${orderId} ${error.message}`);
    }
    if (trust && (trust.blacklisted || trust.score < this.minTrustScore)) {
      const why = trust.blacklisted ? 'the number is blacklisted on HighDelivery' : `its trust score is ${trust.score} (minimum ${this.minTrustScore})`;
      await this.note(orderId, `Auto-send to HighDelivery held for review: ${why} (${trust.totalOrders} parcels, ${trust.deliveredOrders} delivered, ${trust.failedOrders} failed). The order stays on-hold; decide from the desktop app.`);
      return { status: 'held', reason: 'low_trust', trust };
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
      result = await this.hdClient.createPackage(parcel);
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
    await this.note(orderId, `Sent to HighDelivery automatically${tracking ? `. Tracking: ${tracking}` : ''}${parcel.isExpress ? ' (express)' : ''}${trust ? `. Customer trust score: ${trust.score}` : ''}.`);

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

  // off: by name through the CSV, exactly as before. shadow: still by name, but the link result is compared and
  // only the ids are logged, after the fact. on: by the product links (a product without a link still goes through the CSV).
  async matchItems(orderId, full) {
    const warehouse = await this.hdClient.listWarehouseProducts();
    const byName = resolveWarehouseItems(full.line_items, this.productMap, warehouse);
    if (!this.linkIndex || this.linksMode === 'off') {
      return byName;
    }
    if (this.linksMode === 'on') {
      return this.matchByLinks(full, warehouse);
    }
    // Shadow only watches: the comparison runs on its own and never makes the order wait for it.
    this.compareInShadow(orderId, full, warehouse, byName);
    return byName;
  }

  async compareInShadow(orderId, full, warehouse, byName) {
    try {
      const byLink = await this.matchByLinks(full, warehouse);
      this.logger.log(`[hd-links] shadow orderId=${orderId} same=${sameResolution(byName, byLink)} csv=${describeResolution(byName)} link=${describeResolution(byLink)}`);
    } catch (error) {
      this.logger.warn(`[hd-links] shadow orderId=${orderId} link lookup failed: ${error.message}`);
    }
  }

  async matchByLinks(full, warehouse) {
    const unitLookup = await buildUnitLookup(full.line_items, this.linkIndex);
    return resolveOrderItems(full.line_items, { unitLookup, csvMap: this.productMap, warehouse });
  }

  // Tells the team's phones when an order needs a human or the send went wrong, so nobody has to open WooCommerce
  // to find out. Outcomes that need no action (already sent, handled by someone else, feature off) stay silent.
  describeProblem(outcome) {
    const detail = String(outcome?.detail || outcome?.error || '').slice(0, 300);
    switch (outcome?.status) {
      case 'held': {
        const trust = outcome.trust || {};
        return { kind: 'manual', problem: trust.blacklisted ? 'numero blackliste sur HighDelivery' : `numero a risque (score ${trust.score})` };
      }
      case 'skipped':
        if (outcome.reason === 'invalid_order') {
          return { kind: 'manual', problem: detail || 'commande incomplete' };
        }
        if (outcome.reason === 'no_warehouse_match') {
          return { kind: 'manual', problem: detail || 'produit introuvable dans le stock HighDelivery' };
        }
        if (outcome.reason === 'stock_read_failed') {
          return { kind: 'error', problem: `stock HighDelivery illisible: ${detail}` };
        }
        if (['woo_read_failed', 'reservation_failed', 'not_configured'].includes(outcome.reason)) {
          return { kind: 'error', problem: `envoi impossible (${outcome.reason})` };
        }
        return null;
      case 'failed':
        return { kind: 'error', problem: `HighDelivery a refuse: ${detail}` };
      case 'unknown':
        return { kind: 'error', problem: `pas de reponse de HighDelivery, verifier avant de renvoyer (${detail})` };
      case 'error':
        return { kind: 'error', problem: detail || 'erreur inattendue' };
      case 'sent':
        return outcome.completed === false
          ? { kind: 'error', problem: `colis envoye (${outcome.trackingNumber || 'sans numero'}) mais WooCommerce pas passe a termine, ne pas renvoyer` }
          : null;
      default:
        return null;
    }
  }

  async notifyProblem(orderId, order, outcome) {
    try {
      const problem = this.describeProblem(outcome);
      const template = problem?.kind === 'manual' ? this.manualTemplate : this.errorTemplate;
      if (!problem || !template) {
        return 0;
      }
      return await this.sendInternal(orderId, order?.rawOrder || order || {}, template, {
        trackingNumber: outcome?.trackingNumber || '—',
        problem: problem.problem
      }, problem.kind === 'manual' ? 'internal_hd_manual_notification' : 'internal_hd_error_notification');
    } catch (error) {
      this.logger.warn(`[hd-auto-send] could not build the alert for order ${orderId}: ${error.message}`);
      return 0;
    }
  }

  async notify(orderId, raw, tracking) {
    return this.sendInternal(orderId, raw, this.template, { trackingNumber: tracking || '—' }, 'internal_hd_sent_notification');
  }

  // One WhatsApp message to each team phone. Not subject to the customer quiet hours: it is the team's own alert.
  async sendInternal(orderId, raw, template, extra, kind) {
    const oneLine = (value, max = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
    const values = {
      customerName: [raw?.shipping?.first_name, raw?.shipping?.last_name].filter(Boolean).join(' ')
        || [raw?.billing?.first_name, raw?.billing?.last_name].filter(Boolean).join(' ')
        || 'Client',
      orderId,
      trackingNumber: '—',
      problem: '',
      customerPhone: raw?.shipping?.phone || raw?.billing?.phone || '',
      deliveryCity: raw?.shipping?.city || raw?.billing?.city || '',
      deliveryAddress: [raw?.shipping?.address_1, raw?.shipping?.address_2].filter(Boolean).join(', ')
        || [raw?.billing?.address_1, raw?.billing?.address_2].filter(Boolean).join(', '),
      orderItemsSummary: summarizeOrderItems(raw?.line_items || []),
      orderTotal: formatOrderTotal(raw || {}),
      ...extra
    };
    // Customer-typed text must not be able to add lines to the alert.
    for (const key of ['customerName', 'customerPhone', 'deliveryCity', 'deliveryAddress', 'orderItemsSummary', 'problem']) {
      values[key] = oneLine(values[key], key === 'problem' ? 300 : 120);
    }
    const message = interpolateTemplate(template, values);
    let sentTo = 0;
    for (const phone of this.notifyPhones || []) {
      try {
        const sent = await this.wasenderClient.sendMessage({ to: phone, message });
        sentTo += 1;
        this.store?.appendMessage?.({
          source: 'outbound',
          orderId,
          phone,
          kind,
          payload: sent,
          text: message
        });
      } catch (error) {
        this.logger.warn(`[hd-auto-send] could not notify ${maskPhone(phone)} about order ${orderId}: ${error.message}`);
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
