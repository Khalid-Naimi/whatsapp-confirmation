// "Manage my order" (/suivi): the limits and the messages behind /tasks/manage/*, the replacement orders and the
// customer cancel. The website changes the order in WooCommerce; this side sends every customer message, counts them,
// and makes the status changes a reply or a cancel causes. Contract: docs/MANAGE_ORDER.md in connector-wo-hd.
// Methods run with the ConfirmationService as `this`.

import { createHmac } from 'node:crypto';
import { HD_STATUS_META, MANAGE_META, OUTBOUND_LOGICAL_KEYS, REPLACEMENT_META } from '../../domain/order-meta.js';
import { readEditHold } from '../hd-auto-send-service.js';
import { MANAGE_TEXTS } from '../../domain/manage-texts.js';
import {
  ACTIVE_CONFIRMATION_STATUSES,
  CONFIRMED_WOO_STATUSES,
  DECISION,
  SEND_STATE,
  WOO_STATUS,
  WOO_SYNC_STATUS,
  WORKFLOW_STATE
} from '../../domain/order-states.js';
import { interpolateTemplate, normalizePhone } from '../../utils/format.js';
import { outsideLocks } from '../../utils/keyed-lock.js';
import { DEFAULT_QUIET_HOURS } from '../../utils/quiet-hours.js';
import { cancelParcelThen, editParcelThen, inspectParcel } from '../hd-parcel.js';
import { normalizeMoroccanPhone } from '../hd-auto-send-service.js';
import { isWhatsAppContactabilityFailure } from '../wasender-client.js';
import {
  buildDecisionMetaUpdate,
  buildLogicalSendMetaUpdate,
  buildTemplateValues,
  buildWorkflowMetaUpdate,
  getDecisionMeta,
  getOutboundReservationMeta,
  getWorkflowMeta,
  mergeMetaUpdates,
  moroccanLocalPhone,
  normalizeWooOrder,
  readMetaText,
  replacedOrderId
} from './order-helpers.js';
import { isQueuedLongAgo } from './outbound/reserved-send.js';

export const MANAGE_KINDS = Object.freeze(['resend', 'updated', 'address', 'phone', 'replacement', 'contact_address', 'contact_phone']);
// A new address or phone on a confirmed order -> what it changes.
const CONTACT_KINDS = Object.freeze({ contact_address: 'address', contact_phone: 'phone' });
// Unanswered this long, the request is over (as a replacement is).
export const CONTACT_EXPIRY_MS = 72 * 60 * 60 * 1000;
// Messages an order chain may use, the first confirmation included. Reminders do not count.
export const MANAGE_MAX_MESSAGES = 3;
export const MANAGE_COOLDOWN_MS = 3 * 60 * 1000;
export const MANAGE_PHONE_DAILY_LIMIT = 3;
export const DEFAULT_MANAGE_DAILY_SHOP_LIMIT = 60;
// The website waits 60 s for /send. A message that has not left the queue after 20 s is given up (nothing sent), which
// leaves room for WhatsApp's own answer (up to 20 s) inside the 60 s.
export const MANAGE_DISPATCH_BUDGET_MS = 20 * 1000;
// After an accepted /check no parcel is created for the order for this long: the website is changing it.
export const MANAGE_HOLD_MS = 90 * 1000;
// A replacement that never got any message this long after it was made was abandoned half way by the website.
export const REPLACEMENT_UNSENT_MS = 30 * 60 * 1000;
export const MANAGE_LINK_TTL_SECONDS = 45 * 24 * 60 * 60;
// A replacement gets no reminders: it ends where the normal auto-cancel would (48 h + 24 h).
export const REPLACEMENT_EXPIRY_MS = 72 * 60 * 60 * 1000;
// A message held by the quiet hours that still could not go out after this long is dropped.
export const MANAGE_DEFERRED_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// After a failed send, the delayed first message waits this long so the website can undo its change first.
const FIRST_MESSAGE_HOLD_MS = 60 * 1000;

const DEAD_WOO_STATUSES = [WOO_STATUS.cancelled, WOO_STATUS.refunded, WOO_STATUS.failed, WOO_STATUS.trash];
const CORRECTION_KINDS = ['updated', 'address', 'phone'];
const NOTICE_BY_REASON = Object.freeze({
  replacement_too_late: 'replacementTooLate',
  replacement_failed: 'replacementFailed',
  replacement_refused: 'replacementKept'
});

export function manageToken(secret, orderId, exp) {
  const mac = createHmac('sha256', String(secret)).update(`rhymat-manage:${orderId}:${exp}`).digest('hex').slice(0, 32);
  return `${Number(exp).toString(36)}-${mac}`;
}

export function manageCounters(order) {
  const sentAt = getWorkflowMeta(order).confirmationSentAt;
  const stored = Number(readMetaText(order, MANAGE_META.count));
  return {
    count: stored > 0 ? stored : (sentAt ? 1 : 0),
    lastAt: readMetaText(order, MANAGE_META.lastAt) || sentAt || '',
    numberChanged: readMetaText(order, MANAGE_META.numberChanged) === 'yes'
  };
}

// A replacement and the order it replaces share one limit: the higher counters win.
function chainCounters(order, old) {
  const own = manageCounters(order);
  if (!old) {
    return own;
  }
  const other = manageCounters(old);
  return {
    count: Math.max(own.count, other.count),
    lastAt: (Date.parse(other.lastAt) || 0) > (Date.parse(own.lastAt) || 0) ? other.lastAt : own.lastAt,
    numberChanged: own.numberChanged || other.numberChanged
  };
}

// Meta rows with the ids WooCommerce already has; undefined values are left alone.
function metaRows(order, values) {
  const existing = Array.isArray(order?.meta_data) ? order.meta_data : [];
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const row = existing.find((item) => item.key === key);
      return row?.id ? { id: row.id, key, value } : { key, value };
    });
}

// The change of address or phone waiting for the customer's "1", or null.
export function readContactRequest(order, now = new Date()) {
  let request;
  try {
    request = JSON.parse(readMetaText(order, MANAGE_META.contact) || 'null');
  } catch {
    return null;
  }
  const value = String(request?.value || '').trim();
  const age = now.getTime() - Date.parse(request?.askedAt || '');
  return ['address', 'phone'].includes(request?.kind) && value && age < CONTACT_EXPIRY_MS ? { kind: request.kind, value, askedAt: request.askedAt } : null;
}

export function managePhone(order) {
  const raw = order?.billing?.phone || order?.shipping?.phone;
  return normalizePhone(raw) || moroccanLocalPhone(raw);
}

const answer = (count, lastAt, deferred) => ({
  ok: true,
  left: Math.max(0, Math.min(MANAGE_MAX_MESSAGES - 1, MANAGE_MAX_MESSAGES - count)),
  lastSentAt: lastAt || null,
  deferred: Boolean(deferred)
});
const refusal = (reason) => ({ ok: false, reason });

export const manageMethods = {
  // The link in the confirmed reply: /suivi opens this order without asking for the phone number (45 days).
  manageLink(orderId) {
    const base = String(this.messages?.trackingUrlBase || 'https://rhymat.ma/suivi').replace(/[?#].*$/u, '').replace(/\/+$/u, '');
    const link = `${base}/?n=${encodeURIComponent(String(orderId ?? ''))}`;
    if (!this.manageSecret) {
      return link;
    }
    const exp = Math.floor(this.clock().getTime() / 1000) + MANAGE_LINK_TTL_SECONDS;
    return `${link}&k=${manageToken(this.manageSecret, orderId, exp)}`;
  },

  tellTeam(text) {
    if (typeof this.notifyTeam === 'function') {
      this.trackBackground(() => Promise.resolve(this.notifyTeam(text)), 'team notice');
    }
  },

  async readOrderOrNull(orderId) {
    try {
      return (await this.wooClient.getOrder(orderId)) || null;
    } catch (error) {
      if (error?.status === 404 || /failed with 404|not found/iu.test(String(error?.message))) {
        return null;
      }
      throw error;
    }
  },

  // One lock order everywhere, so a swap and a cancel never wait for each other: the old order first, then its
  // replacement.
  async withManageLocks(orderId, work, known = null) {
    let order = Array.isArray(known?.meta_data) ? known : null;
    if (!order && typeof this.wooClient.getOrder === 'function') {
      order = await this.wooClient.getOrder(orderId).catch(() => null);
    }
    const oldId = replacedOrderId(order);
    if (!oldId || oldId === String(orderId)) {
      return this.withOrderLock(orderId, work);
    }
    return this.withOrderLock(oldId, () => this.withOrderLock(orderId, work));
  },

  isWaitingOrder(order) {
    const decision = getDecisionMeta(order);
    return ACTIVE_CONFIRMATION_STATUSES.includes(String(order?.status || ''))
      && !decision.decision
      && !this.store.getOrder(String(order.id))?.decision
      && decision.manualOverride !== 'yes'
      && ![WORKFLOW_STATE.confirmed, WORKFLOW_STATE.cancelled, WORKFLOW_STATE.manual].includes(getWorkflowMeta(order).state);
  },

  // A person changed the order's status by hand: the service no longer acts on it.
  handledByHand(order) {
    return getDecisionMeta(order).manualOverride === 'yes' || this.store.getOrder(String(order?.id))?.manualOverride === 'yes';
  },

  // Confirmed, so it may be replaced: the customer's confirmation, or the "confirmed" status the team set. On-hold (or
  // completed) alone is not enough: it may be held for a problem.
  isConfirmedStageOrder(order) {
    const status = String(order?.status || '');
    const decision = getDecisionMeta(order).decision;
    if (this.handledByHand(order) || decision === DECISION.cancelled) {
      return false;
    }
    if (decision === DECISION.confirmed) {
      return [...CONFIRMED_WOO_STATUSES, ...ACTIVE_CONFIRMATION_STATUSES, WOO_STATUS.completed].includes(status);
    }
    return status === WOO_STATUS.confirmed;
  },

  // --- Daily caps -----------------------------------------------------------------------------------------------

  manageDay() {
    const timeZone = this.messages?.quietHours?.timeZone || DEFAULT_QUIET_HOURS.timeZone;
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.clock());
  },

  dailyRefusal(phone) {
    const daily = this.store.getManageDaily(this.manageDay());
    if ((daily.phones[phone] || 0) >= MANAGE_PHONE_DAILY_LIMIT) {
      return 'daily_phone_limit';
    }
    if (daily.shop >= this.manageDailyShopLimit) {
      this.alertShopLimit();
      return 'shop_daily_limit';
    }
    return '';
  },

  countDaily(phone, step) {
    const daily = this.store.updateManageDaily(this.manageDay(), (row) => {
      row.shop = Math.max(0, row.shop + step);
      row.phones[phone] = Math.max(0, (row.phones[phone] || 0) + step);
    });
    if (step > 0 && daily.shop >= this.manageDailyShopLimit) {
      this.alertShopLimit();
    }
  },

  alertShopLimit() {
    const day = this.manageDay();
    if (this.store.getManageDaily(day).alerted) {
      return;
    }
    this.store.updateManageDaily(day, (row) => {
      row.alerted = true;
    });
    this.tellTeam(`Rhymat: la limite de ${this.manageDailyShopLimit} messages par jour de la page commande (MANAGE_DAILY_SHOP_LIMIT) est atteinte. Les prochaines demandes sont refusees jusqu'a demain.`);
  },

  // --- check / send ---------------------------------------------------------------------------------------------

  // "resend" asked for an order whose replacement is waiting means the replacement.
  async resolveManageTarget(orderId, kind) {
    if (kind !== 'resend') {
      return String(orderId);
    }
    const order = await this.readOrderOrNull(orderId);
    const pending = readMetaText(order, REPLACEMENT_META.replacementPending);
    if (!order || !pending || replacedOrderId(order) || this.isWaitingOrder(order)) {
      return String(orderId);
    }
    const next = await this.readOrderOrNull(pending);
    return replacedOrderId(next) === String(orderId) ? pending : String(orderId);
  },

  // May a message of this kind go out for this order now? For "replacement", `orderId` is the old order before the
  // new one exists (check) and the new order afterwards (send).
  async evaluateManage(orderId, kind, { forSend = false } = {}) {
    const order = await this.readOrderOrNull(orderId);
    if (!order) {
      return refusal('not_found');
    }
    const replaces = replacedOrderId(order);
    const old = replaces ? await this.readOrderOrNull(replaces) : null;
    const beforeReplacement = kind === 'replacement' && !replaces;
    if (this.handledByHand(order) || (old && this.handledByHand(old))) {
      return refusal('not_changeable');
    }

    const contactKind = CONTACT_KINDS[kind];
    if (contactKind) {
      if (replaces || !this.isConfirmedStageOrder(order)) {
        return refusal('not_changeable');
      }
      if (readMetaText(order, REPLACEMENT_META.replacementPending)) {
        return refusal('pending');
      }
      if (forSend && readContactRequest(order, this.clock())?.kind !== contactKind) {
        return refusal('not_changeable');
      }
      const parcel = await inspectParcel(order, this.hdAutoSend?.hdClient || null);
      if (parcel.state === 'collected' || parcel.state === 'unverified') {
        this.logger.log(`[manage] not changeable orderId=${order.id} ${parcel.detail}`);
        return refusal('not_changeable');
      }
    } else if (kind === 'replacement') {
      let current = order;
      if (replaces) {
        if (!this.isWaitingOrder(order)) {
          return refusal('not_pending');
        }
        const pending = readMetaText(old, REPLACEMENT_META.replacementPending);
        if (!old || (pending && pending !== String(orderId))) {
          return refusal('not_changeable');
        }
        current = old;
      } else if (forSend) {
        return refusal('not_changeable');
      }
      if (!this.isConfirmedStageOrder(current)) {
        return refusal('not_changeable');
      }
      const parcel = await inspectParcel(current, this.hdAutoSend?.hdClient || null);
      if (parcel.state === 'collected' || parcel.state === 'unverified') {
        this.logger.log(`[manage] not changeable orderId=${current.id} ${parcel.detail}`);
        return refusal('not_changeable');
      }
    } else if (!this.isWaitingOrder(order)) {
      return refusal('not_pending');
    }

    const counters = chainCounters(order, old);
    if ((kind === 'phone' || kind === 'contact_phone') && counters.numberChanged) {
      return refusal('number_already_changed');
    }
    // A message already held for the morning is replaced, not added: it has been counted.
    const held = !beforeReplacement && Boolean(readMetaText(order, MANAGE_META.deferred));
    if (!held && counters.count >= MANAGE_MAX_MESSAGES) {
      return refusal('limit');
    }
    if (kind === 'resend' && counters.count === 0 && this.pendingInitialConfirmations.has(String(orderId))) {
      return refusal('cooldown');
    }
    const needsGap = kind === 'resend' ? counters.count >= 1 : counters.count >= 2;
    if (needsGap && this.clock().getTime() - Date.parse(counters.lastAt) < MANAGE_COOLDOWN_MS) {
      return refusal('cooldown');
    }
    if (!beforeReplacement) {
      // A send of this very message is under way (or got no answer yet).
      const key = getWorkflowMeta(order).confirmationSentAt
        ? (counters.count >= 2 ? OUTBOUND_LOGICAL_KEYS.manage3 : OUTBOUND_LOGICAL_KEYS.manage2)
        : OUTBOUND_LOGICAL_KEYS.confirmationRequest;
      const outbound = getOutboundReservationMeta(order, key);
      if (outbound.state === SEND_STATE.reserved && !isQueuedLongAgo(outbound, this.clock())) {
        return refusal('cooldown');
      }
    }
    const phone = managePhone(order);
    if (!held) {
      const reason = this.dailyRefusal(phone);
      if (reason) {
        return refusal(reason);
      }
    }
    // The very first confirmation of an order is never held for the quiet hours.
    const firstConfirmation = !replaces && !beforeReplacement && counters.count === 0;
    return { ok: true, order, replaces, counters, held, phone, quiet: this.isQuietNow() && !firstConfirmation && !contactKind };
  },

  async manageCheck(orderId, kind) {
    const target = await this.resolveManageTarget(orderId, kind);
    return this.withManageLocks(target, async () => {
      const result = await this.evaluateManage(target, kind);
      if (!result.ok) {
        return result;
      }
      // The website changes the order next: a delayed first message must not run in the middle of that.
      if (kind !== 'replacement') {
        const waiting = this.cancelFirstMessageTimer(target);
        if (waiting) {
          this.rearmFirstMessage(waiting, target);
        }
      }
      // The website changes the order next: no parcel from half-changed data (the old order too for a replacement).
      await this.placeEditHold(result.order);
      if (result.replaces) {
        await this.placeEditHold(await this.readOrderOrNull(result.replaces));
      }
      return answer(result.counters.count, result.counters.lastAt, result.quiet);
    });
  },

  async placeEditHold(order) {
    if (!order || !this.hdAutoSend?.enabled) {
      return;
    }
    const orderId = String(order.id);
    const untilMs = Date.now() + this.manageHoldMs;
    this.hdAutoSend.holdForEdit(orderId, untilMs);
    const flag = readEditHold(order).sendWaiting ? '|send' : '';
    try {
      await this.wooClient.updateOrderMeta(orderId, metaRows(order, { [MANAGE_META.holdUntil]: `${new Date(untilMs).toISOString()}${flag}` }));
    } catch (error) {
      this.logger.warn(`[manage] could not record the edit hold orderId=${orderId}: ${error.message}`);
    }
  },

  // Only after a successful /send. A refused one lets the hold run out, so the website's undo lands first.
  async releaseEditHold(orderId) {
    if (!this.hdAutoSend?.enabled) {
      return;
    }
    this.hdAutoSend.releaseEditHold(orderId);
    try {
      const order = await this.wooClient.getOrder(orderId);
      if (readMetaText(order, MANAGE_META.holdUntil)) {
        // An auto-send still waiting keeps its mark (already expired) for the hourly task.
        const value = readEditHold(order).sendWaiting ? `${new Date().toISOString()}|send` : '';
        await this.wooClient.updateOrderMeta(orderId, metaRows(order, { [MANAGE_META.holdUntil]: value }));
      }
    } catch (error) {
      this.logger.warn(`[manage] could not release the edit hold orderId=${orderId}: ${error.message}`);
    }
  },

  cancelFirstMessageTimer(orderId) {
    const key = String(orderId);
    const pending = this.initialConfirmationDueAt.get(key);
    if (!pending) {
      return null;
    }
    clearTimeout(this.pendingInitialConfirmations.get(key));
    this.pendingInitialConfirmations.delete(key);
    this.initialConfirmationDueAt.delete(key);
    return pending.payload;
  },

  rearmFirstMessage(payload, orderId) {
    const delay = Math.max(Number(this.messages.confirmationDelayMs) || 0, FIRST_MESSAGE_HOLD_MS);
    outsideLocks(() => this.scheduleInitialConfirmation(payload, String(orderId), delay));
  },

  async manageSend(orderId, kind) {
    const dispatchBy = Date.now() + this.manageDispatchBudgetMs;
    const target = await this.resolveManageTarget(orderId, kind);
    return this.withManageLocks(target, async () => {
      const result = await this.evaluateManage(target, kind, { forSend: true });
      if (!result.ok) {
        return result;
      }
      const { order, replaces, counters, held, phone } = result;
      if (Date.now() > dispatchBy) {
        return refusal('send_failed');
      }
      if (!phone) {
        return refusal('invalid_number');
      }
      const timerPayload = counters.count === 0 ? this.cancelFirstMessageTimer(target) : null;
      const slot = held ? Math.max(counters.count, 1) : counters.count + 1;
      const numberChanged = counters.numberChanged || kind === 'phone';
      // A resend of a held correction is still that correction.
      const heldKind = readMetaText(order, MANAGE_META.deferred).split('|')[0];
      const messageKind = kind === 'resend' && CORRECTION_KINDS.includes(heldKind) ? heldKind : kind;
      if (!held) {
        this.countDaily(phone, 1);
      }
      let sent = refusal('send_failed');
      try {
        sent = result.quiet
          ? await this.holdManageMessage(order, messageKind, { phone, slot, numberChanged })
          : await this.deliverManageMessage(order, messageKind, { phone, slot, numberChanged, dispatchBy });
      } catch (error) {
        this.logger.warn(`[manage] send failed orderId=${target} kind=${kind}: ${error.message}`);
      }
      if (!sent.ok) {
        if (!held) {
          this.countDaily(phone, -1);
        }
        if (counters.count === 0 && !replaces) {
          this.firstMessageHolds.set(target, Date.now() + FIRST_MESSAGE_HOLD_MS);
          if (timerPayload) {
            this.rearmFirstMessage(timerPayload, target);
          }
        }
        return refusal(sent.reason);
      }
      await this.copyCountersToReplacedOrder(order, { count: slot, lastAt: sent.lastAt, numberChanged });
      await this.releaseEditHold(target);
      if (replaces) {
        await this.releaseEditHold(replaces);
      }
      return answer(slot, sent.lastAt, sent.deferred);
    });
  },

  manageMetaRows(order, { slot, lastAt, numberChanged, deferred = '' }) {
    return metaRows(order, {
      [MANAGE_META.count]: slot,
      [MANAGE_META.lastAt]: lastAt,
      [MANAGE_META.numberChanged]: numberChanged ? 'yes' : undefined,
      [MANAGE_META.deferred]: deferred
    });
  },

  // Quiet hours: the counters are taken now, the hourly task sends the message in the morning.
  async holdManageMessage(order, kind, { phone, slot, numberChanged }) {
    const nowIso = this.clock().toISOString();
    const updated = await this.wooClient.updateOrderMeta(String(order.id), mergeMetaUpdates(
      this.manageMetaRows(order, { slot, lastAt: nowIso, numberChanged, deferred: `${kind}|${nowIso}` }),
      buildDecisionMetaUpdate(order, { invalidReplyCount: 0, manualFollowupRequired: 'no' })
    ));
    const current = { ...order, ...(updated || {}) };
    this.store.upsertOrder({ ...normalizeWooOrder(current, this.messages), phone, rawOrder: current });
    return { ok: true, deferred: true, lastAt: nowIso };
  },

  buildManageMessage(normalizedOrder, order, kind) {
    if (CONTACT_KINDS[kind]) {
      const request = readContactRequest(order, this.clock());
      return this.contactText(CONTACT_KINDS[kind] === 'phone' ? 'contactPhone' : 'contactAddress', {
        orderId: normalizedOrder.orderId,
        value: request?.kind === 'phone' ? normalizeMoroccanPhone(request.value) || request.value : request?.value || ''
      });
    }
    const oldOrderId = replacedOrderId(order);
    const values = { ...buildTemplateValues(normalizedOrder), oldOrderId, manageLink: this.manageLink(normalizedOrder.orderId) };
    const body = interpolateTemplate(this.messages.confirmationTemplate, values);
    // "The old one no longer counts" only makes sense when there was an old message.
    const header = oldOrderId
      ? MANAGE_TEXTS.replacementHeader
      : (getWorkflowMeta(order).confirmationSentAt && CORRECTION_KINDS.includes(kind) ? MANAGE_TEXTS.updatedHeader : '');
    return header ? `${interpolateTemplate(header, values)}\n\n${body}` : body;
  },

  // Sends one /suivi message. The first message of an order is its confirmation request (so the reply, the reminders and
  // the stale-send handling work as usual); later ones have their own record per slot.
  // -> { ok: true, lastAt } | { ok: false, reason: 'invalid_number' | 'send_failed' }
  async deliverManageMessage(order, kind, { phone, slot, numberChanged, dispatchBy = 0 }) {
    const orderId = String(order.id);
    const sentBefore = getWorkflowMeta(order).confirmationSentAt;
    const contactKind = CONTACT_KINDS[kind];
    const request = contactKind ? readContactRequest(order, this.clock()) : null;
    // A contact change is never the order's first confirmation: the order stays as confirmed as it was.
    const logicalKey = sentBefore || contactKind
      ? (slot >= 3 ? OUTBOUND_LOGICAL_KEYS.manage3 : OUTBOUND_LOGICAL_KEYS.manage2)
      : OUTBOUND_LOGICAL_KEYS.confirmationRequest;
    const normalizedOrder = { ...normalizeWooOrder(order, this.messages), phone };
    const now = this.clock();
    const pendingEntry = (rawOrder, sentAt) => ({
      ...normalizedOrder,
      rawOrder,
      confirmationState: 'pending_confirmation',
      confirmationSentAt: sentAt,
      invalidReplyCount: 0,
      manualFollowupRequired: false,
      decision: '',
      decisionAt: '',
      manageLastAt: now.toISOString()
    });
    let outcome;
    // The time the limits count from (set again once the provider accepted).
    let lastAt = now.toISOString();
    // The website reads the send records to learn whether a message may have left when an answer is lost. A new
    // reservation shows up there; taking over an old one that never left the queue does not, so the time is written too.
    const takingOver = getOutboundReservationMeta(order, logicalKey).state === SEND_STATE.reserved;
    const markTime = (value) => this.wooClient.updateOrderMeta(orderId, metaRows(order, { [MANAGE_META.lastAt]: value }));
    const unmarkTime = () => (takingOver
      ? markTime(readMetaText(order, MANAGE_META.lastAt)).catch((error) => this.logger.warn(`[manage] could not restore the time orderId=${orderId}: ${error.message}`))
      : null);
    try {
      if (takingOver) {
        await markTime(lastAt);
      }
      outcome = await this.sendLogicalMessageWithWooReservation({
        orderPayload: order,
        orderId,
        phone,
        logicalKey,
        kind: sentBefore || contactKind ? 'manage_message' : 'confirmation_request',
        message: this.buildManageMessage(normalizedOrder, order, kind),
        now,
        dispatchBy,
        persistAfterSend: async ({ acceptedAt, providerMessageId, reservedAt }) => {
          lastAt = this.clock().toISOString();
          const counters = this.manageMetaRows(order, { slot, lastAt, numberChanged });
          let persisted;
          if (contactKind) {
            persisted = await this.wooClient.updateOrderMeta(orderId, mergeMetaUpdates(
              buildLogicalSendMetaUpdate(order, logicalKey, { state: SEND_STATE.sent, reservedAt, sentAt: acceptedAt, messageId: providerMessageId || '' }),
              counters
            ));
            this.rememberContactRequest(persisted || order, phone, request);
          } else if (!sentBefore) {
            persisted = await this.persistInitialConfirmationMeta({ orderPayload: order, normalizedOrder, acceptedAt, providerMessageId, reservedAt, extraMeta: counters });
            this.store.upsertOrder(pendingEntry(persisted, acceptedAt));
          } else {
            persisted = await this.wooClient.updateOrderMeta(orderId, mergeMetaUpdates(
              buildLogicalSendMetaUpdate(order, logicalKey, { state: SEND_STATE.sent, reservedAt, sentAt: acceptedAt, messageId: providerMessageId || '' }),
              buildDecisionMetaUpdate(order, { invalidReplyCount: 0, manualFollowupRequired: 'no' }),
              counters
            ));
            this.store.upsertOrder(pendingEntry(persisted || order, sentBefore));
          }
          await this.safeAddOrderNote(orderId, `WhatsApp message sent for the customer's order page (${kind}).`);
          return persisted;
        }
      });
    } catch (error) {
      await unmarkTime();
      if (isWhatsAppContactabilityFailure(error)) {
        // Never cancels the order: the website undoes the change.
        return refusal('invalid_number');
      }
      this.logger.warn(`[manage] send failed orderId=${orderId}: ${error.message}`);
      return refusal('send_failed');
    }

    if (outcome.ambiguous) {
      // It may have gone out: counted, kept open for the answer, never sent again.
      try {
        await this.wooClient.updateOrderMeta(orderId, this.manageMetaRows(order, { slot, lastAt, numberChanged }));
      } catch (error) {
        this.logger.warn(`[manage] could not record the counters orderId=${orderId}: ${error.message}`);
      }
      if (contactKind) {
        this.rememberContactRequest(order, phone, request);
      } else {
        this.store.upsertOrder({ ...pendingEntry(order, sentBefore || lastAt), lastError: 'ambiguous_send_state' });
      }
      return { ok: true, deferred: false, lastAt };
    }
    if (!outcome.persisted) {
      await unmarkTime();
      return refusal('send_failed');
    }
    // No confirmation poll here: one outbound message per /suivi action (the text already says to reply 1).
    return { ok: true, deferred: false, lastAt };
  },

  // The replaced order carries the chain's counters too, so dropping a replacement does not give the messages back.
  async copyCountersToReplacedOrder(order, { count, lastAt, numberChanged }) {
    const oldId = replacedOrderId(order);
    if (!oldId) {
      return;
    }
    try {
      const old = await this.wooClient.getOrder(oldId);
      await this.wooClient.updateOrderMeta(oldId, metaRows(old, {
        [MANAGE_META.count]: Math.max(count, manageCounters(old).count),
        [MANAGE_META.lastAt]: lastAt,
        [MANAGE_META.numberChanged]: numberChanged ? 'yes' : undefined
      }));
    } catch (error) {
      this.logger.warn(`[manage] could not copy the counters to orderId=${oldId}: ${error.message}`);
    }
  },

  // Hourly, outside the quiet hours: a message held at night goes out now (with the data as it is now).
  async sendDeferredManageMessage(order, now = new Date()) {
    const orderId = String(order.id);
    const [kind, heldAt] = readMetaText(order, MANAGE_META.deferred).split('|');
    const clear = () => this.wooClient.updateOrderMeta(orderId, metaRows(order, { [MANAGE_META.deferred]: '' }));
    if (!this.isWaitingOrder(order) || !(now.getTime() - Date.parse(heldAt) <= MANAGE_DEFERRED_MAX_AGE_MS)) {
      await clear();
      return false;
    }
    const oldId = replacedOrderId(order);
    if (oldId && !this.isConfirmedStageOrder(await this.wooClient.getOrder(oldId))) {
      await clear();
      this.tellTeam(`Rhymat: la commande ${orderId} devait remplacer la ${oldId}, qui n'est plus modifiable: message retenu la nuit non envoye. A verifier.`);
      return false;
    }
    const counters = manageCounters(order);
    const phone = managePhone(order);
    const slot = Math.max(counters.count, 1);
    const sent = phone
      ? await this.deliverManageMessage(order, kind, { phone, slot, numberChanged: counters.numberChanged })
      : refusal('invalid_number');
    if (sent.ok) {
      await this.copyCountersToReplacedOrder(order, { count: slot, lastAt: sent.lastAt, numberChanged: counters.numberChanged });
      return true;
    }
    if (sent.reason === 'invalid_number') {
      await clear();
      await this.safeAddOrderNote(orderId, 'The WhatsApp message held overnight could not be sent: the number is not on WhatsApp. The order was not changed or cancelled.');
      this.tellTeam(`Rhymat: commande ${orderId}: le message de la page commande n'a pas pu partir (numero pas sur WhatsApp). A verifier a la main.`);
    }
    return false;
  },

  // --- Cancels --------------------------------------------------------------------------------------------------

  // The service's own cancel: status and decision in one write, so the order webhook never reads it as a manual change.
  // Nothing is sent to the customer here.
  async writeServiceCancellation(order, { cancellationReason, extraMeta = [], note }) {
    const orderId = String(order.id);
    const nowIso = this.clock().toISOString();
    const fields = {
      status: WOO_STATUS.cancelled,
      meta_data: mergeMetaUpdates(
        buildWorkflowMetaUpdate(order, { state: WORKFLOW_STATE.cancelled, cancelledAt: nowIso }),
        buildDecisionMetaUpdate(order, {
          decision: DECISION.cancelled,
          decisionAt: nowIso,
          wooSyncStatus: WOO_SYNC_STATUS.synced,
          wooSyncAttempts: 0,
          lastSyncError: '',
          customerReplySent: 'yes',
          cancellationReason,
          manualFollowupRequired: 'no'
        }),
        metaRows(order, { [MANAGE_META.deferred]: '', [MANAGE_META.contact]: readMetaText(order, MANAGE_META.contact) ? '' : undefined }),
        extraMeta
      )
    };
    let updated;
    try {
      updated = await this.wooClient.updateOrder(orderId, fields);
    } catch (error) {
      const after = await this.readOrderOrNull(orderId).catch(() => null);
      if (after?.status === WOO_STATUS.cancelled && getDecisionMeta(after).decision === DECISION.cancelled) {
        updated = after;
      } else {
        this.logger.warn(`[manage] cancel write failed, trying once more orderId=${orderId}: ${error.message}`);
        updated = await this.wooClient.updateOrder(orderId, fields);
      }
    }
    const current = { ...order, ...(updated || {}) };
    this.store.upsertOrder({
      ...normalizeWooOrder(current, this.messages),
      rawOrder: current,
      confirmationState: 'cancelled',
      wooStatus: WOO_STATUS.cancelled,
      decision: DECISION.cancelled,
      // Left empty: this is not a customer's answer (see findRecentlyDecidedOrder).
      decisionAt: '',
      wooSyncStatus: WOO_SYNC_STATUS.synced,
      customerReplySent: 'yes',
      cancellationReason
    });
    await this.safeAddOrderNote(orderId, note);
    return current;
  },

  async clearPendingReplacement(oldId, newId) {
    try {
      const old = await this.wooClient.getOrder(oldId);
      if (readMetaText(old, REPLACEMENT_META.replacementPending) === String(newId)) {
        await this.wooClient.updateOrderMeta(oldId, metaRows(old, { [REPLACEMENT_META.replacementPending]: '' }));
      }
    } catch (error) {
      this.logger.warn(`[manage] could not clear the waiting replacement of orderId=${oldId}: ${error.message}`);
    }
  },

  // Silently cancels the replacement waiting on `old`. Only an unconfirmed order that names `old` is ever cancelled.
  async dropWaitingReplacement(old, cancellationReason) {
    const oldId = String(old.id);
    const newId = readMetaText(old, REPLACEMENT_META.replacementPending);
    if (!/^\d+$/u.test(newId) || newId === oldId) {
      return refusal('no_replacement');
    }
    return this.withOrderLock(newId, async () => {
      const next = await this.readOrderOrNull(newId);
      const fresh = await this.wooClient.getOrder(oldId);
      if (!next || replacedOrderId(next) !== oldId || readMetaText(fresh, REPLACEMENT_META.replacedBy) === newId) {
        return refusal('no_replacement');
      }
      if (next.status !== WOO_STATUS.cancelled) {
        if (this.handledByHand(next)) {
          return refusal('not_changeable');
        }
        if (!ACTIVE_CONFIRMATION_STATUSES.includes(String(next.status || '')) || getDecisionMeta(next).decision === DECISION.confirmed) {
          return refusal('no_replacement');
        }
        await this.writeServiceCancellation(next, {
          cancellationReason,
          note: `Replacement of order #${oldId} dropped (no message sent).`
        });
      }
      await this.clearPendingReplacement(oldId, newId);
      return { ok: true };
    });
  },

  async manageDropReplacement(orderId) {
    return this.withManageLocks(orderId, async () => {
      const order = await this.readOrderOrNull(orderId);
      return order ? this.dropWaitingReplacement(order, 'replacement_dropped') : refusal('not_found');
    });
  },

  async manageCancel(orderId, reason = '') {
    const id = String(orderId);
    const why = String(reason || '').replace(/\s+/gu, ' ').trim().slice(0, 120);
    return this.withManageLocks(id, async () => {
      const order = await this.readOrderOrNull(id);
      if (!order) {
        return refusal('not_found');
      }
      const status = String(order.status || '');
      const note = `Cancelled by the customer on the order page${why ? ` (reason: ${why})` : ''}.`;
      const replaces = replacedOrderId(order);
      if (replaces && ACTIVE_CONFIRMATION_STATUSES.includes(status) && getDecisionMeta(order).decision !== DECISION.confirmed) {
        if (this.handledByHand(order)) {
          return this.leaveCancelToTeam(id);
        }
        // A waiting replacement: only it goes, the order it was meant to replace stays.
        await this.writeServiceCancellation(order, { cancellationReason: 'customer_website', note });
        await this.clearPendingReplacement(replaces, id);
        return { ok: true };
      }
      if (status === WOO_STATUS.cancelled) {
        await this.dropWaitingReplacement(order, 'replacement_dropped');
        return { ok: true };
      }
      if (DEAD_WOO_STATUSES.includes(status) || status === WOO_STATUS.delivered) {
        return refusal('too_late');
      }
      // Only an order that is clearly not held for a problem: still waiting for the answer, or confirmed.
      if (this.handledByHand(order) || !(ACTIVE_CONFIRMATION_STATUSES.includes(status) || this.isConfirmedStageOrder(order))) {
        return this.leaveCancelToTeam(id);
      }
      this.cancelFirstMessageTimer(id);
      let parcelCancelled = false;
      let result;
      try {
        result = await cancelParcelThen({
          orderId: id,
          hdAutoSend: this.hdAutoSend,
          wooClient: this.wooClient,
          reason: `Annulee par le client (Woo #${id})`,
          logger: this.logger,
          apply: async (fresh, info) => {
            parcelCancelled = info.parcelCancelled;
            return this.writeServiceCancellation(fresh, {
              cancellationReason: 'customer_website',
              extraMeta: parcelCancelled ? metaRows(fresh, { [HD_STATUS_META.status]: 'cancelled', [HD_STATUS_META.statusAt]: this.clock().toISOString() }) : [],
              note: `${note}${parcelCancelled ? ' HighDelivery parcel cancelled.' : ''}`
            });
          }
        });
      } catch (error) {
        if (!parcelCancelled) {
          throw error;
        }
        this.tellTeam(`ATTENTION: commande ${id}: colis HighDelivery annule a la demande du client mais la commande n'a pas pu etre annulee dans WooCommerce. A annuler a la main.`);
        return refusal('hd_cancel_failed');
      }
      if (result.outcome === 'too_late') {
        return refusal('too_late');
      }
      if (result.outcome !== 'ok') {
        this.logger.warn(`[manage] cancel refused orderId=${id}: ${result.detail}`);
        this.tellTeam(`ATTENTION: le client veut annuler la commande ${id} mais le colis HighDelivery n'a pas pu etre annule (${String(result.detail).slice(0, 160)}). A faire a la main.`);
        return refusal('hd_cancel_failed');
      }
      await this.dropWaitingReplacement(await this.wooClient.getOrder(id), 'replacement_dropped')
        .catch((error) => this.logger.warn(`[manage] could not drop the replacement of orderId=${id}: ${error.message}`));
      this.trackBackground(() => this.sendInternalDecisionNotifications({
        order: this.store.getOrder(id),
        decision: DECISION.cancelled,
        alreadyNotified: false
      }), `team notice cancel ${id}`);
      return { ok: true };
    });
  },

  // The customer wants to cancel an order a person handles: refused, and the team is told (once per order).
  leaveCancelToTeam(orderId) {
    if (!this.reportedCancelRequests.has(orderId)) {
      this.reportedCancelRequests.add(orderId);
      this.tellTeam(`ATTENTION: le client veut annuler la commande ${orderId} (page commande). Elle est geree a la main ou en attente: rien n'a ete fait, a traiter.`);
    }
    return refusal('not_changeable');
  },

  // --- New address or phone on a confirmed order -----------------------------------------------------------------

  contactText(name, values) {
    return interpolateTemplate(this.messages[`${name}Message`] || MANAGE_TEXTS[name], values);
  },

  rememberContactRequest(order, phone, request) {
    const orderId = String(order.id);
    const known = this.store.getOrder(orderId);
    this.store.upsertOrder({
      ...(known || { ...normalizeWooOrder(order, this.messages), confirmationState: 'confirmed' }),
      rawOrder: order,
      contactPhone: phone,
      contactAskedAt: request?.askedAt || this.clock().toISOString()
    });
  },

  forgetContactRequest(orderId) {
    if (this.store.getOrder(String(orderId))) {
      this.store.upsertOrder({ orderId: String(orderId), contactPhone: '', contactAskedAt: '' });
    }
  },

  // The order waiting for this number's "1" on a contact change: from the local record, else (after a restart, when
  // `recover`) from the confirmed orders in WooCommerce. -> { orderId, askedAt } or null.
  async findContactRequest(phone, recover) {
    const newest = (rows) => rows.sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt))[0] || null;
    const local = newest(this.store.listContactRequestsByPhone(phone)
      .filter((order) => this.clock().getTime() - Date.parse(order.contactAskedAt) < CONTACT_EXPIRY_MS)
      .map((order) => ({ orderId: String(order.orderId), askedAt: order.contactAskedAt })));
    if (local || !recover) {
      return local;
    }
    let orders = [];
    try {
      orders = await this.listOrdersForStatuses([...new Set([...CONFIRMED_WOO_STATUSES, ...ACTIVE_CONFIRMATION_STATUSES, WOO_STATUS.completed])], { after: new Date(this.clock().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString() });
    } catch (error) {
      this.logger.warn(`[manage] could not look for a waiting contact change: ${error.message}`);
    }
    return newest((orders || [])
      .filter((order) => managePhone(order) === phone)
      .map((order) => ({ orderId: String(order.id), askedAt: readContactRequest(order, this.clock())?.askedAt }))
      .filter((row) => row.askedAt));
  },

  // The customer's typed "1" or "2" on a contact change. -> { route } when it was one, { context } with the orders
  // looked up in WooCommerce when it answers one of those instead, or null.
  async routeContactReply(message, answerText, context) {
    if (!['1', '2'].includes(answerText) || String(message.messageKey).startsWith('poll:')) {
      return null;
    }
    // WooCommerce is read whenever no order waits for a confirmation: the local record is empty after a restart.
    const waiting = await this.findContactRequest(message.senderPhone, !context.pendingOrder);
    if (!waiting) {
      return null;
    }
    // Before applying anything: orders waiting for a confirmation that this process does not remember.
    const recovered = context.pendingOrder ? null : await this.resolveReplyContext(message.senderPhone, { allowWooRecovery: true });
    const askedMs = Date.parse(waiting.askedAt);
    // A message that went out later (a replacement, a new order, a reminder) is the one being answered.
    const later = (recovered || context).pendingOrders.some((order) => [
      order.manageLastAt,
      order.confirmationSentAt,
      order.lastReminderAt,
      readMetaText(order.rawOrder, MANAGE_META.lastAt),
      getWorkflowMeta(order.rawOrder || {}).confirmationSentAt,
      getWorkflowMeta(order.rawOrder || {}).lastReminderAt
    ].some((at) => Date.parse(at || '') > askedMs));
    // The same answer given again right after it settled another order is not about this change.
    const repeat = this.findRecentlyDecidedOrder(message.senderPhone, answerText);
    if (later || (repeat && Date.parse(repeat.decisionAt) > askedMs)) {
      return recovered?.pendingOrder ? { context: recovered } : null;
    }
    const route = await this.withOrderLock(waiting.orderId, () => this.applyContactReply(waiting.orderId, answerText, message));
    return route ? { route } : null;
  },

  async applyContactReply(orderId, answerText, message) {
    const order = await this.readOrderOrNull(orderId);
    const request = readContactRequest(order, this.clock());
    if (!request || managePhone(order) !== message.senderPhone) {
      this.forgetContactRequest(orderId);
      return null;
    }
    this.appendInboundMessage({ message, orderId, storedKind: 'customer_reply' });
    const done = { ok: true, ignored: false, duplicate: false, failed: false, route: 'confirmation', eventStatus: 'processed' };
    const isPhone = request.kind === 'phone';
    const say = (name) => this.safeSendTrackedMessage({
      phone: message.senderPhone,
      orderId,
      kind: 'manage_contact_reply',
      message: this.contactText(name, { orderId })
    });
    const clear = () => this.wooClient.updateOrderMeta(orderId, metaRows(order, { [MANAGE_META.contact]: '' }));
    const finish = async (name, note) => {
      await clear().catch((error) => this.logger.warn(`[manage] could not clear the contact change orderId=${orderId}: ${error.message}`));
      this.forgetContactRequest(orderId);
      await this.safeAddOrderNote(orderId, note);
      await say(name);
      return done;
    };

    if (answerText === '2') {
      return finish(isPhone ? 'contactKeptPhone' : 'contactKeptAddress', 'The customer refused the new address or phone asked for on the order page.');
    }
    if (!this.isConfirmedStageOrder(order) || readMetaText(order, REPLACEMENT_META.replacementPending)) {
      return finish('contactFailed', 'The new address or phone could not be applied: the order is not in a changeable state.');
    }
    const parcelPhone = isPhone ? normalizeMoroccanPhone(request.value) : '';
    if (isPhone && !parcelPhone) {
      return finish('contactFailed', 'The new phone could not be applied: not a Moroccan number.');
    }

    const checkByHand = (detail) => {
      this.tellTeam(`ATTENTION: commande ${orderId}: ${isPhone ? 'nouveau numero' : 'nouvelle adresse'} (${request.value}) peut-etre appliquee a moitie. Verifier High Delivery ET WooCommerce. ${String(detail).slice(0, 160)}`);
      return finish('contactChecking', `The new ${request.kind} may be half applied, check by hand: ${detail}`);
    };
    let result;
    try {
      result = await editParcelThen({
        orderId,
        hdAutoSend: this.hdAutoSend,
        wooClient: this.wooClient,
        patch: isPhone ? { recipient_phone: parcelPhone } : { address: request.value },
        logger: this.logger,
        apply: async (fresh) => {
          // The parcel's address is one line: the second line must not keep an old half.
          const change = isPhone ? { phone: request.value } : { address_1: request.value, address_2: '' };
          const shippingHas = Boolean(isPhone ? fresh.shipping?.phone : fresh.shipping?.address_1);
          const updated = await this.wooClient.updateOrder(orderId, {
            billing: { ...fresh.billing, ...change },
            ...(shippingHas ? { shipping: { ...fresh.shipping, ...change } } : {}),
            meta_data: metaRows(fresh, {
              [MANAGE_META.contact]: '',
              [MANAGE_META.contactDone]: request.askedAt,
              [MANAGE_META.numberChanged]: isPhone ? 'yes' : undefined
            })
          });
          return { ...fresh, ...(updated || {}) };
        }
      });
    } catch (error) {
      this.logger.warn(`[manage] contact change failed orderId=${orderId}: ${error.message}`);
      return checkByHand(error.message);
    }
    if (result.outcome === 'unsure') {
      return checkByHand(result.detail);
    }
    if (result.outcome === 'too_late') {
      return finish('contactTooLate', 'The new address or phone came too late: the courier has the parcel.');
    }
    if (result.outcome !== 'ok') {
      this.tellTeam(`ATTENTION: le client veut ${isPhone ? 'un autre numero' : 'une autre adresse'} pour la commande ${orderId} (${request.value}) mais le colis High Delivery n'a pas pu etre modifie (${String(result.detail).slice(0, 160)}). A faire a la main.`);
      return finish('contactFailed', `The new ${request.kind} could not be applied: ${result.detail}`);
    }
    this.forgetContactRequest(orderId);
    const current = result.value;
    const known = this.store.getOrder(orderId);
    if (known) {
      const normalized = normalizeWooOrder(current, this.messages);
      this.store.upsertOrder({ ...known, rawOrder: current, phone: normalized.phone || known.phone, deliveryAddress: normalized.deliveryAddress, contactPhone: '', contactAskedAt: '' });
    }
    await this.safeAddOrderNote(orderId, `The customer confirmed a new ${request.kind} on WhatsApp${result.parcelEdited ? '; the HighDelivery parcel was updated' : ''}.`);
    this.tellTeam(`Rhymat: commande ${orderId}: ${isPhone ? 'nouveau numero' : 'nouvelle adresse'} : ${request.value}${result.parcelEdited ? ' (colis High Delivery modifie)' : ''}.${result.check ? ` ATTENTION: ${result.check}, verifier le colis.` : ''}`);
    await say(isPhone ? 'contactDonePhone' : 'contactDoneAddress');
    return done;
  },

  // --- Replacement orders ---------------------------------------------------------------------------------------

  replacementNotice(reason, oldOrderId) {
    const key = NOTICE_BY_REASON[reason];
    return key ? interpolateTemplate(this.messages[`${key}Message`] || MANAGE_TEXTS[key], { oldOrderId }) : '';
  },

  // The customer answered 1 or 2 on a replacement (both order locks are held). Decides what happens to it:
  // { nextState, cancellationReason, message } or { abort: true } when nothing can be decided safely.
  async resolveReplacementReply({ order, reply, freshRead }) {
    const newId = String(order.id);
    const oldId = replacedOrderId(order);
    const abort = (why) => {
      this.tellTeam(`ATTENTION: reponse "${reply}" sur la commande ${newId} (remplace la ${oldId}) non traitee: ${why}. A faire a la main.`);
      return { abort: true };
    };
    if (!freshRead) {
      return abort('commande illisible dans WooCommerce');
    }
    let old;
    try {
      old = await this.wooClient.getOrder(oldId);
    } catch (error) {
      this.logger.warn(`[manage] could not read the replaced order ${oldId}: ${error.message}`);
      return abort('ancienne commande illisible');
    }
    const confirmed = { nextState: DECISION.confirmed, cancellationReason: '', message: '' };
    const cancelled = (cancellationReason, message = this.replacementNotice(cancellationReason, oldId)) => (
      { nextState: DECISION.cancelled, cancellationReason, message }
    );
    // The swap already happened (a restart before the confirmation was written): finish it.
    if (readMetaText(old, REPLACEMENT_META.replacedBy) === newId) {
      return reply === '1' ? confirmed : cancelled('replacement_refused', this.messages.cancelledReply);
    }
    const alive = !DEAD_WOO_STATUSES.includes(String(old.status || ''));
    if (reply === '2') {
      return cancelled('replacement_refused', alive ? this.replacementNotice('replacement_refused', oldId) : '');
    }
    if (!alive) {
      this.tellTeam(`Rhymat: le client a confirme la commande ${newId} mais la ${oldId} qu'elle remplace etait deja annulee: la ${newId} est annulee aussi (aucun message envoye).`);
      return cancelled('replacement_old_cancelled', '');
    }
    const pending = readMetaText(old, REPLACEMENT_META.replacementPending);
    if (pending && pending !== newId) {
      return cancelled('replacement_failed');
    }
    if (old.status === WOO_STATUS.delivered) {
      return cancelled('replacement_too_late');
    }
    if (!this.isConfirmedStageOrder(old)) {
      this.tellTeam(`ATTENTION: la commande ${oldId} est geree a la main ou en attente: elle n'a pas ete remplacee par la ${newId}, qui est annulee.`);
      return cancelled('replacement_failed');
    }
    const swap = await this.swapOutOldOrder(old, order);
    if (swap.outcome === 'too_late') {
      return cancelled('replacement_too_late');
    }
    if (swap.outcome !== 'ok') {
      this.logger.warn(`[manage] swap failed old=${oldId} new=${newId}: ${swap.detail}`);
      this.tellTeam(`ATTENTION: la commande ${oldId} n'a pas pu etre remplacee par la ${newId} (${String(swap.detail).slice(0, 160)}). La ${oldId} reste, la ${newId} est annulee.`);
      return cancelled('replacement_failed');
    }
    return confirmed;
  },

  // Are the replacement's items still in the shop's stock, counting what the old order holds (it comes back when that
  // order is cancelled)? -> '' or the problem. Products without managed stock or with backorders are not counted.
  async replacementStockProblem(next, old) {
    const products = new Map();
    const variations = new Map();
    const cached = async (cache, id, read) => {
      if (!cache.has(id)) {
        cache.set(id, await read());
      }
      return cache.get(id);
    };
    const product = (id) => cached(products, id, () => this.wooClient.getProduct(id));
    // The stock record a line takes from: the variation's own, or its product's.
    const recordOf = async (line) => {
      const productId = Number(line?.product_id);
      if (!productId) {
        return null;
      }
      const variationId = Number(line.variation_id) || 0;
      let entity;
      let key = `p${productId}`;
      if (variationId) {
        const list = await cached(variations, productId, () => this.wooClient.listVariations(productId));
        const variation = list.find((item) => Number(item.id) === variationId);
        if (!variation) {
          return { key: `v${variationId}`, stock: 0 };
        }
        if (variation.manage_stock === 'parent') {
          entity = await product(productId);
        } else {
          entity = variation;
          key = `v${variationId}`;
        }
      } else {
        entity = await product(productId);
      }
      const backorders = entity?.backorders && entity.backorders !== 'no';
      return entity?.manage_stock === true && !backorders ? { key, stock: Number(entity.stock_quantity) || 0 } : null;
    };
    try {
      const wanted = new Map();
      for (const line of next?.line_items || []) {
        const record = await recordOf(line);
        if (record) {
          const row = wanted.get(record.key) || { need: 0, stock: record.stock, name: String(line.name || line.product_id) };
          row.need += Number(line.quantity) || 0;
          wanted.set(record.key, row);
        }
      }
      for (const line of old?.line_items || []) {
        // WooCommerce notes on each line how many pieces it took from the stock.
        const taken = Number((line.meta_data || []).find((meta) => meta.key === '_reduced_stock')?.value) || 0;
        const record = taken > 0 ? await recordOf(line) : null;
        if (record && wanted.has(record.key)) {
          wanted.get(record.key).stock += taken;
        }
      }
      const short = [...wanted.values()].find((row) => row.stock < row.need);
      return short ? `plus assez de stock pour ${short.name}` : '';
    } catch (error) {
      return `stock illisible: ${error.message}`;
    }
  },

  // Stock checked, parcel first, then the old order (no cancel message, no email).
  async swapOutOldOrder(old, next) {
    const oldId = String(old.id);
    const newId = String(next.id);
    let parcelCancelled = false;
    let result;
    try {
      result = await cancelParcelThen({
        orderId: oldId,
        hdAutoSend: this.hdAutoSend,
        wooClient: this.wooClient,
        reason: `Remplacee par Woo #${newId}`,
        logger: this.logger,
        precheck: (fresh) => this.replacementStockProblem(next, fresh),
        apply: async (fresh, info) => {
          parcelCancelled = info.parcelCancelled;
          if (DEAD_WOO_STATUSES.includes(String(fresh.status || ''))) {
            throw new Error(`the old order became ${fresh.status}`);
          }
          return this.writeServiceCancellation(fresh, {
            cancellationReason: 'replaced',
            extraMeta: metaRows(fresh, {
              [REPLACEMENT_META.replacedBy]: newId,
              [REPLACEMENT_META.replacementPending]: '',
              ...(parcelCancelled ? { [HD_STATUS_META.status]: 'cancelled', [HD_STATUS_META.statusAt]: this.clock().toISOString() } : {})
            }),
            note: `Replaced by order #${newId}, which the customer confirmed.${parcelCancelled ? ' HighDelivery parcel cancelled.' : ''}`
          });
        }
      });
    } catch (error) {
      if (!parcelCancelled) {
        return { outcome: 'failed', detail: error.message };
      }
      // The old parcel is gone, so the new order must go on; the old order is left for the team.
      this.tellTeam(`ATTENTION: colis de la commande ${oldId} annule (remplacee par la ${newId}) mais WooCommerce n'a pas pu l'annuler. L'annuler a la main.`);
      await this.wooClient.updateOrderMeta(oldId, metaRows(old, { [REPLACEMENT_META.replacedBy]: newId, [REPLACEMENT_META.replacementPending]: '' }))
        .catch((metaError) => this.logger.warn(`[manage] could not mark orderId=${oldId} as replaced: ${metaError.message}`));
      return { outcome: 'ok' };
    }
    if (result.outcome === 'ok' && result.parcelCancelled) {
      this.tellTeam(`Rhymat: commande ${oldId} remplacee par la ${newId}: l'ancien colis HighDelivery est annule.`);
    }
    return result;
  },

  // The website stopped between making a replacement and /send: no message, no record of one, older than 30 minutes.
  isAbandonedReplacement(order, now) {
    const raw = String(order?.date_created_gmt || '');
    const createdMs = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw) ? raw : `${raw}Z`);
    const reserved = [OUTBOUND_LOGICAL_KEYS.confirmationRequest, OUTBOUND_LOGICAL_KEYS.manage2, OUTBOUND_LOGICAL_KEYS.manage3]
      .some((key) => getOutboundReservationMeta(order, key).state);
    const workflow = getWorkflowMeta(order);
    return Boolean(replacedOrderId(order))
      && ACTIVE_CONFIRMATION_STATUSES.includes(String(order.status || ''))
      && !workflow.state
      && !workflow.confirmationSentAt
      && !getDecisionMeta(order).decision
      && !readMetaText(order, MANAGE_META.deferred)
      && !reserved
      && now.getTime() - createdMs > REPLACEMENT_UNSENT_MS;
  },

  // No answer to a replacement (or it was never sent): only the replacement goes, silently.
  async expireReplacement(order, { cancellationReason = 'replacement_expired', why = 'never confirmed' } = {}) {
    const newId = String(order.id);
    const oldId = replacedOrderId(order);
    const old = await this.readOrderOrNull(oldId);
    if (readMetaText(old, REPLACEMENT_META.replacedBy) === newId) {
      this.logger.warn(`[manage] order ${newId} already replaced ${oldId} but was never confirmed; not cancelled, check it by hand`);
      return false;
    }
    await this.writeServiceCancellation(order, {
      cancellationReason,
      note: `Replacement of order #${oldId} ${why}: cancelled, #${oldId} stays (no message sent).`
    });
    await this.clearPendingReplacement(oldId, newId);
    return true;
  },

  // A replacement changed by hand: the swap will not happen by itself.
  async afterReplacementOverride(order, status) {
    const oldId = replacedOrderId(order);
    if (!oldId) {
      return;
    }
    if (DEAD_WOO_STATUSES.includes(String(status || ''))) {
      await this.clearPendingReplacement(oldId, order.id);
      return;
    }
    this.tellTeam(`ATTENTION: la commande ${order.id} (remplacement de la ${oldId}) a ete changee a la main: la ${oldId} n'est pas annulee automatiquement. Verifier pour ne pas envoyer deux colis.`);
  }
};
