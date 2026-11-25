// Size exchange after delivery, asked on /suivi. The website writes the request on the order; this side sends the
// question, and on the customer's "1" creates the exchange parcel on HighDelivery. One exchange per order: whatever
// happens after the "1", it is never tried twice. Contract: docs/MANAGE_ORDER.md in connector-wo-hd.
// Methods run with the ConfirmationService as `this`.

import { HD_META } from '../hd-auto-send-service.js';
import { MANAGE_META } from '../../domain/order-meta.js';
import { CONFIRMED_WOO_STATUSES, WOO_STATUS } from '../../domain/order-states.js';
import { foldHdStatus } from '../../utils/hd-status.js';
import { claim } from '../claim.js';
import { describeItems } from '../hd-product-match.js';
import { HighDeliveryError } from '../highdelivery-client.js';
import { isWhatsAppContactabilityFailure } from '../wasender-client.js';
import { managePhone } from './manage.js';
import { readMetaText } from './order-helpers.js';

export const EXCHANGE_EXPIRY_MS = 72 * 60 * 60 * 1000;
// From the delivery to the request; the website counts the same days.
export const EXCHANGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const EXCHANGE_MAX_ASKS = 3;
const EXCHANGE_COOLDOWN_MS = 3 * 60 * 1000;
const CLAIM_TTL_MS = 10 * 60 * 1000;
// A "sending" record older than this was left by a stop in the middle.
const STALE_SENDING_MS = 15 * 60 * 1000;

const text = (value) => String(value ?? '').trim();

function parseJson(value) {
  try {
    return JSON.parse(value || 'null');
  } catch {
    return null;
  }
}

// What happened after a "1": { askedAt, state: 'sending'|'done'|'team', tracking, items }, or null.
export function readExchangeDone(order) {
  const done = parseJson(readMetaText(order, MANAGE_META.exchangeDone));
  return done && typeof done === 'object' && done.state ? done : null;
}

// The exchange waiting for the customer's "1", or null.
export function readExchangeRequest(order, now = new Date()) {
  const request = parseJson(readMetaText(order, MANAGE_META.exchange));
  const items = (Array.isArray(request?.items) ? request.items : []).map((item) => ({
    item: Number(item?.item) || 0,
    productId: Number(item?.productId) || 0,
    variationId: Number(item?.variationId) || 0,
    woo: text(item?.woo),
    name: text(item?.name),
    from: text(item?.from),
    to: text(item?.to),
    qty: Math.max(1, Math.floor(Number(item?.qty) || 1))
  }));
  const age = now.getTime() - Date.parse(request?.askedAt || '');
  const usable = items.length > 0 && items.every((item) => item.woo && item.name && item.to && item.variationId);
  return usable && age < EXCHANGE_EXPIRY_MS && !readExchangeDone(order) ? { askedAt: request.askedAt, items } : null;
}

export function exchangeLines(items) {
  return items.map((item) => `${item.name}${item.qty > 1 ? ` x${item.qty}` : ''} : ${item.from} → ${item.to}`);
}

const trackingOf = (row) => text(row?.tracking_number ?? row?.trackingNumber).toUpperCase();
const exchangeOf = (row) => text(row?.exchange_of_tracking).toUpperCase();

// The delivered parcel an exchange can be made from, read live. `at` is when the customer asked.
export async function findExchangeParcel(order, hdClient, at) {
  const no = (detail) => ({ ok: false, detail });
  if (!hdClient?.isConfigured?.()) {
    return no('HighDelivery n\'est pas configure');
  }
  const tracking = readMetaText(order, HD_META.tracking).trim().toUpperCase();
  let rows;
  try {
    rows = (await hdClient.listPackages()) || [];
  } catch (error) {
    return no(`colis illisibles: ${error.message}`);
  }
  const mine = rows.filter((row) => (tracking
    ? trackingOf(row) === tracking
    : text(row?.comment ?? row?.note) === `Woo #${order.id}` && !exchangeOf(row)));
  const row = mine.find((item) => foldHdStatus(item.status) === 'delivered');
  if (!row) {
    return no(mine.length ? `colis ${foldHdStatus(mine[0].status) || 'sans statut'}, pas livre` : 'colis introuvable');
  }
  const own = trackingOf(row);
  if (text(row.exchange_new_tracking) || text(row.reimburse_new_tracking) || rows.some((item) => exchangeOf(item) && exchangeOf(item) === own)) {
    return no('ce colis a deja un echange ou un remboursement');
  }
  const delivered = Date.parse(row.delivered_at ?? row.deliveredAt ?? '');
  if (delivered && Date.parse(at) - delivered > EXCHANGE_WINDOW_MS) {
    return no('livre depuis plus de 14 jours');
  }
  if (row.id === undefined && row._id === undefined) {
    return no('le colis n\'a pas d\'identifiant');
  }
  return { ok: true, row, id: row.id ?? row._id, tracking: own };
}

const refusal = (reason) => ({ ok: false, reason });

export const exchangeMethods = {
  // May the question go out? Its own limit: the three-message limit of the order is usually used up before delivery.
  async evaluateExchange(order, { forSend = false, phone = '' } = {}) {
    const status = text(order.status);
    if ([WOO_STATUS.cancelled, WOO_STATUS.refunded, WOO_STATUS.failed, WOO_STATUS.trash].includes(status)) {
      return refusal('not_changeable');
    }
    if (readExchangeDone(order)) {
      return refusal('exchange_used');
    }
    const request = readExchangeRequest(order, this.clock());
    if (forSend && !request) {
      return refusal('not_changeable');
    }
    const [count, lastAt] = readMetaText(order, MANAGE_META.exchangeAsks).split('|');
    const asks = Number(count) || 0;
    if (asks >= EXCHANGE_MAX_ASKS) {
      return refusal('limit');
    }
    if (asks && this.clock().getTime() - Date.parse(lastAt || '') < EXCHANGE_COOLDOWN_MS) {
      return refusal('cooldown');
    }
    const daily = this.dailyRefusal(phone);
    if (daily) {
      return refusal(daily);
    }
    const parcel = await findExchangeParcel(order, this.hdAutoSend?.hdClient || null, this.clock().toISOString());
    if (!parcel.ok) {
      this.logger.log(`[manage] no exchange orderId=${order.id} ${parcel.detail}`);
      return refusal('not_changeable');
    }
    return { ok: true, order, phone, request, asks };
  },

  // A direct send: these answer the customer's own action, so the quiet hours do not drop them.
  async sayExchange(phone, orderId, name, values = {}) {
    const message = this.contactText(name, { orderId, ...values });
    const result = await this.wasenderClient.sendMessage({ to: phone, message });
    this.store.appendMessage({ source: 'outbound', orderId, phone, kind: 'manage_exchange', payload: result, text: message });
  },

  async sendExchangeQuestion({ order, phone, request, asks }) {
    const orderId = String(order.id);
    const nowIso = this.clock().toISOString();
    if (!phone) {
      return refusal('invalid_number');
    }
    this.countDaily(phone, 1);
    try {
      await this.sayExchange(phone, orderId, 'exchangeAsk', { items: exchangeLines(request.items).join('\n') });
    } catch (error) {
      // No answer from the provider: the message may be on its way, so the request stays.
      if (!error?.ambiguous) {
        this.countDaily(phone, -1);
        this.logger.warn(`[manage] exchange question failed orderId=${orderId}: ${error.message}`);
        return refusal(isWhatsAppContactabilityFailure(error) ? 'invalid_number' : 'send_failed');
      }
    }
    this.rememberContactRequest(order, phone, request);
    await this.wooClient.updateOrderMeta(orderId, this.exchangeRows(order, { [MANAGE_META.exchangeAsks]: `${asks + 1}|${nowIso}` }))
      .catch((error) => this.logger.warn(`[manage] could not count the exchange question orderId=${orderId}: ${error.message}`));
    await this.safeAddOrderNote(orderId, 'WhatsApp question sent: size exchange asked on the order page.');
    return { ok: true, left: 0, lastSentAt: nowIso, deferred: false };
  },

  exchangeRows(order, values) {
    const existing = Array.isArray(order?.meta_data) ? order.meta_data : [];
    return Object.entries(values).map(([key, value]) => {
      const row = existing.find((item) => item.key === key);
      return row?.id ? { id: row.id, key, value } : { key, value };
    });
  },

  // The customer answered 1 or 2 on a size exchange (the order lock is held).
  async applyExchangeReply(order, request, answerText, message) {
    const orderId = String(order.id);
    const done = { ok: true, ignored: false, duplicate: false, failed: false, route: 'confirmation', eventStatus: 'processed' };
    const phone = message.senderPhone;
    const lines = exchangeLines(request.items).join(', ');
    this.appendInboundMessage({ message, orderId, storedKind: 'customer_reply' });
    const say = (name) => this.sayExchange(phone, orderId, name)
      .catch((error) => this.logger.warn(`[manage] exchange answer not sent orderId=${orderId}: ${error.message}`));

    if (answerText === '2') {
      await this.wooClient.updateOrderMeta(orderId, this.exchangeRows(order, { [MANAGE_META.exchange]: '' }))
        .catch((error) => this.logger.warn(`[manage] could not clear the exchange orderId=${orderId}: ${error.message}`));
      this.forgetContactRequest(orderId);
      await this.safeAddOrderNote(orderId, 'The customer refused the size exchange asked for on the order page.');
      await say('exchangeKept');
      return done;
    }

    // `at`: when this state was written, so a stop in the middle can be found later.
    const record = (state, tracking = '') => JSON.stringify({ askedAt: request.askedAt, at: this.clock().toISOString(), state, tracking, items: request.items });
    const stillAsked = (fresh) => readExchangeRequest(fresh, this.clock())?.askedAt === request.askedAt;
    const dropped = async () => {
      this.forgetContactRequest(orderId);
      await say('exchangeKept');
      return done;
    };
    let claimed = null;
    try {
      claimed = await claim(this.wooClient, orderId, MANAGE_META.exchangeClaim, {
        ttlMs: CLAIM_TTL_MS,
        state: 'exchange',
        settleMs: this.hdAutoSend?.claimSettleMs,
        sleep: this.hdAutoSend?.sleep,
        logger: this.logger,
        check: (fresh) => {
          if (readExchangeDone(fresh)) {
            return 'done';
          }
          return stillAsked(fresh) ? '' : 'dropped';
        }
      });
      if (!claimed.ok) {
        return claimed.reason === 'dropped' ? dropped() : { ...done, duplicate: true, eventStatus: 'duplicate_final_reply' };
      }
      // "Annuler la demande" on the website while the claim settled.
      if (claimed.order && !stillAsked(claimed.order)) {
        await claimed.release().catch(() => {});
        return dropped();
      }
      // Written before the parcel: after a stop nobody creates a second one.
      await this.wooClient.updateOrderMeta(orderId, this.exchangeRows(claimed.order || order, { [MANAGE_META.exchangeDone]: record('sending') }));
    } catch (error) {
      // Nothing was created and nobody is asked to do it by hand: the same "1" can simply be sent again. (Should the
      // record have landed after all, the hourly task finds it and tells the team.)
      this.logger.warn(`[manage] exchange not started orderId=${orderId}: ${error.message}`);
      if (claimed?.ok) {
        await claimed.release().catch(() => {});
      }
      await say('exchangeRetry');
      return done;
    }

    const result = await this.createExchangeParcel(order, request)
      .catch((error) => ({ outcome: 'unsure', detail: error.message }));
    const ok = result.outcome === 'ok';
    try {
      await this.wooClient.updateOrderMeta(orderId, this.exchangeRows(claimed.order || order, {
        [MANAGE_META.exchange]: '',
        [MANAGE_META.exchangeDone]: record(ok ? 'done' : 'team', result.tracking || ''),
        [MANAGE_META.exchangeClaim]: ''
      }));
    } catch (error) {
      this.logger.warn(`[manage] could not record the exchange orderId=${orderId}: ${error.message}`);
    }
    this.forgetContactRequest(orderId);

    if (ok) {
      await this.safeAddOrderNote(orderId, `Size exchange confirmed on WhatsApp: ${lines}. HighDelivery parcel ${result.tracking || '(tracking unknown)'} created.`);
      this.tellTeam(`Rhymat: echange cree sur High Delivery, commande ${orderId}: ${lines}. Nouveau colis ${result.tracking || '?'}. Verifier le retour de l'ancienne piece.`);
      await say('exchangeDone');
      return done;
    }
    await this.safeAddOrderNote(orderId, `Size exchange confirmed on WhatsApp (${lines}) but not created for sure on HighDelivery: ${result.detail}`);
    this.tellTeam(result.outcome === 'unsure'
      ? `ATTENTION: commande ${orderId}: echange PEUT-ETRE cree sur High Delivery (${lines}). Verifier avant d'en creer un. ${String(result.detail).slice(0, 160)}`
      : `ATTENTION: echange demande par le client, commande ${orderId}: ${lines}. PAS cree sur High Delivery (${String(result.detail).slice(0, 160)}). A faire a la main.`);
    await say('exchangeTeam');
    return done;
  },

  // Hourly: an exchange left at "sending" (the process stopped, or the result could not be saved). HighDelivery is only
  // read: either the new parcel is there, or a person has to look. Never creates anything.
  async settleStaleExchanges() {
    let orders = [];
    try {
      orders = await this.listOrdersForStatuses([...new Set([...CONFIRMED_WOO_STATUSES, WOO_STATUS.completed, WOO_STATUS.delivered])], { after: new Date(this.clock().getTime() - 45 * 24 * 60 * 60 * 1000).toISOString() });
    } catch (error) {
      this.logger.warn(`[manage] could not look for unfinished exchanges: ${error.message}`);
      return 0;
    }
    const stale = (order) => {
      const record = readExchangeDone(order);
      return record?.state === 'sending' && this.clock().getTime() - Date.parse(record.at || record.askedAt || '') > STALE_SENDING_MS;
    };
    let settled = 0;
    for (const listed of (orders || []).filter(stale)) {
      const orderId = String(listed.id);
      await this.withOrderLock(orderId, async () => {
        const order = await this.wooClient.getOrder(orderId);
        if (!stale(order)) {
          return;
        }
        const record = readExchangeDone(order);
        const rows = await this.hdAutoSend?.hdClient?.listPackages();
        if (!rows) {
          return;
        }
        const own = readMetaText(order, HD_META.tracking).trim().toUpperCase()
          || trackingOf(rows.find((row) => text(row?.comment ?? row?.note) === `Woo #${orderId}` && !exchangeOf(row)));
        const child = own ? rows.find((row) => exchangeOf(row) === own) : null;
        const tracking = trackingOf(child) || text(own && rows.find((row) => trackingOf(row) === own)?.exchange_new_tracking);
        const lines = exchangeLines(record.items || []).join(', ');
        await this.wooClient.updateOrderMeta(orderId, this.exchangeRows(order, {
          [MANAGE_META.exchange]: '',
          [MANAGE_META.exchangeDone]: JSON.stringify({ ...record, at: this.clock().toISOString(), state: tracking ? 'done' : 'team', tracking }),
          [MANAGE_META.exchangeClaim]: ''
        }));
        this.forgetContactRequest(orderId);
        this.tellTeam(tracking
          ? `Rhymat: echange cree sur High Delivery, commande ${orderId}: ${lines}. Nouveau colis ${tracking}. Verifier le retour de l'ancienne piece.`
          : `ATTENTION: commande ${orderId}: echange interrompu (${lines}). Aucun nouveau colis visible sur High Delivery: verifier, puis le faire a la main.`);
        const phone = managePhone(order);
        if (phone) {
          await this.sayExchange(phone, orderId, tracking ? 'exchangeDone' : 'exchangeTeam')
            .catch((error) => this.logger.warn(`[manage] exchange answer not sent orderId=${orderId}: ${error.message}`));
        }
        settled += 1;
      }).catch((error) => this.logger.warn(`[manage] could not settle the exchange orderId=${orderId}: ${error.message}`));
    }
    return settled;
  },

  // -> { outcome: 'ok', tracking } | { outcome: 'failed' | 'unsure', detail }. "failed" means nothing was created.
  async createExchangeParcel(order, request) {
    const failed = (detail) => ({ outcome: 'failed', detail });
    const hdClient = this.hdAutoSend?.hdClient || null;
    const parcel = await findExchangeParcel(order, hdClient, request.askedAt);
    if (!parcel.ok) {
      return failed(parcel.detail);
    }
    const wanted = request.items.map((item) => ({ name: item.woo, product_id: item.productId, variation_id: item.variationId, quantity: item.qty }));
    const body = { codAmount: 0 };
    if (this.hdAutoSend.productMap) {
      let matched;
      try {
        matched = await this.hdAutoSend.matchItems(String(order.id), { ...order, line_items: wanted });
      } catch (error) {
        return failed(`stock illisible: ${error.message}`);
      }
      if (!matched.ok) {
        return failed(matched.problems.join('; '));
      }
      body.warehouseItems = matched.items.map(({ productId, quantity }) => ({ productId, quantity }));
      body.productName = describeItems(matched.items);
    } else {
      body.productName = wanted.map((line) => `${line.name} x${line.quantity}`).join(', ');
    }

    try {
      const made = await hdClient.createExchange(parcel.id, body);
      return { outcome: 'ok', tracking: made.trackingNumber || '' };
    } catch (error) {
      const detail = error instanceof HighDeliveryError ? error.detail() : error.message;
      if (!error?.ambiguous) {
        return failed(`High Delivery a refuse: ${detail}`);
      }
      // No answer: only a parcel that now shows as exchanged counts.
      const rows = await hdClient.listPackages().catch(() => []);
      const child = rows.find((row) => exchangeOf(row) === parcel.tracking);
      const old = rows.find((row) => trackingOf(row) === parcel.tracking);
      const tracking = trackingOf(child) || text(old?.exchange_new_tracking);
      return tracking ? { outcome: 'ok', tracking } : { outcome: 'unsure', detail: `pas de reponse de High Delivery: ${detail}` };
    }
  }
};
