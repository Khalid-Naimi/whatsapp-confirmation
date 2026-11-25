// The HighDelivery side of a customer's cancel or order swap: is the parcel collected, and if not, cancel it while
// nobody else can create one. Anything that cannot be verified is "failed": the order is then left as it is.
import { HD_META, HD_STATUS_META } from '../domain/order-meta.js';
import { HD_STATE, WOO_STATUS } from '../domain/order-states.js';
import { HD_COLLECTED_STATUSES, HD_NOT_COLLECTED_STATUSES, foldHdStatus } from '../utils/hd-status.js';
import { claim } from './claim.js';

const CLAIM_TTL_MS = 10 * 60 * 1000;

function metaValue(order, key) {
  const row = (order?.meta_data || []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

const trackingOf = (row) => String(row?.tracking_number ?? row?.trackingNumber ?? '').trim().toUpperCase();
// Both the server and the desktop app write "Woo #<id>" as the parcel comment.
const belongsTo = (row, orderId) => String(row?.comment ?? row?.note ?? '').trim() === `Woo #${orderId}`;

// -> { state: 'none' | 'open' | 'collected' | 'unverified', parcels: [rows still to cancel], detail }
// The parcel list is read live: the status stored on the order is only as fresh as the last hourly sync.
export async function inspectParcel(order, hdClient) {
  const orderId = String(order?.id ?? '');
  const stored = foldHdStatus(metaValue(order, HD_STATUS_META.status));
  const answer = (state, detail = '', parcels = []) => ({ state, detail, parcels });
  if (HD_COLLECTED_STATUSES.has(stored)) {
    return answer('collected', `parcel status ${stored}`);
  }
  const tracking = metaValue(order, HD_META.tracking).trim().toUpperCase();
  const sendState = metaValue(order, HD_META.state);
  const traces = Boolean(tracking || stored || metaValue(order, HD_META.sentAt)
    || [HD_STATE.sending, HD_STATE.sent, HD_STATE.unknown].includes(sendState));
  if (!traces) {
    // "completed" means someone shipped it; without any trace the parcel cannot be found or stopped.
    return String(order?.status || '') === WOO_STATUS.completed
      ? answer('unverified', 'the order is completed but has no HighDelivery parcel on record')
      : answer('none');
  }
  if (!hdClient?.isConfigured?.()) {
    return answer('unverified', 'HighDelivery is not configured');
  }
  let packages;
  try {
    packages = await hdClient.listPackages();
  } catch (error) {
    return answer('unverified', `could not read the parcels: ${error.message}`);
  }
  const rows = (packages || []).filter((row) => (tracking && trackingOf(row) === tracking) || belongsTo(row, orderId));
  if (tracking ? !rows.some((row) => trackingOf(row) === tracking) : !rows.length) {
    return stored === 'cancelled' ? answer('none') : answer('unverified', `the parcel ${tracking || `of Woo #${orderId}`} was not found on HighDelivery`);
  }
  const statuses = rows.map((row) => foldHdStatus(row.status));
  const collected = statuses.find((status) => HD_COLLECTED_STATUSES.has(status) || !HD_NOT_COLLECTED_STATUSES.has(status));
  if (collected) {
    return answer('collected', `parcel status ${collected}`);
  }
  const open = rows.filter((row) => foldHdStatus(row.status) !== 'cancelled');
  return open.length ? answer('open', '', open) : answer('none');
}

// Runs `work(freshOrder, hdClient)` while the auto-send (in memory) and any other sender (the claim) are held off, so
// no parcel appears while one is being changed. -> what `work` returns, or { outcome: 'failed', detail }.
async function withParcelHeld({ orderId, hdAutoSend, wooClient, logger }, work) {
  const id = String(orderId);
  const guarded = async () => {
    let claimed = null;
    try {
      let order = await wooClient.getOrder(id);
      // "sent" already blocks every sender; otherwise take the claim so nobody creates a parcel meanwhile.
      if (hdAutoSend && metaValue(order, HD_META.state) !== HD_STATE.sent) {
        claimed = await claim(wooClient, id, HD_META.claim, {
          ttlMs: CLAIM_TTL_MS,
          state: 'manage',
          settleMs: hdAutoSend.claimSettleMs,
          sleep: hdAutoSend.sleep,
          instanceId: hdAutoSend.instanceId,
          logger
        });
        if (!claimed.ok) {
          return { outcome: 'failed', detail: 'the order is being sent to HighDelivery right now' };
        }
        order = await wooClient.getOrder(id);
      }
      return await work(order, hdAutoSend?.hdClient || null);
    } finally {
      if (claimed?.ok) {
        await claimed.release().catch((error) => logger.warn(`[manage] could not release the HighDelivery claim orderId=${id}: ${error.message}`));
      }
    }
  };
  if (!hdAutoSend?.runExclusive) {
    return guarded();
  }
  const attempt = await hdAutoSend.runExclusive(id, guarded);
  return attempt.ran ? attempt.value : { outcome: 'failed', detail: 'the HighDelivery auto-send is still running for this order' };
}

// Cancels the order's parcel (if any) and then runs `apply(freshOrder, { parcelCancelled })`, which changes the order.
// `precheck(order)` (optional) runs before any parcel is cancelled; a text it returns stops everything.
// -> { outcome: 'ok', value, parcelCancelled } | { outcome: 'too_late' | 'failed', detail }. A throw from apply passes.
export async function cancelParcelThen({ orderId, hdAutoSend = null, wooClient, reason = '', precheck = null, apply, logger = console }) {
  return withParcelHeld({ orderId, hdAutoSend, wooClient, logger }, async (order, hdClient) => {
      const parcel = await inspectParcel(order, hdClient);
      if (parcel.state === 'collected') {
        return { outcome: 'too_late', detail: parcel.detail };
      }
      if (parcel.state === 'unverified') {
        return { outcome: 'failed', detail: parcel.detail };
      }
      const problem = precheck ? await precheck(order) : '';
      if (problem) {
        return { outcome: 'failed', detail: problem };
      }
      for (const row of parcel.parcels) {
        const parcelId = row.id ?? row._id;
        if (parcelId === undefined || parcelId === null) {
          return { outcome: 'failed', detail: 'the parcel has no id to cancel it with' };
        }
        try {
          await hdClient.cancelPackage(parcelId, reason);
        } catch (error) {
          // No answer: it may have been carried out. Only a fresh "cancelled" counts.
          let after = null;
          if (error?.ambiguous) {
            after = await hdClient.listPackages().then((rows) => rows.find((item) => (item.id ?? item._id) === parcelId), () => null);
          }
          if (foldHdStatus(after?.status) !== 'cancelled') {
            return { outcome: 'failed', detail: `HighDelivery refused the cancel: ${error.message}` };
          }
        }
      }
      const parcelCancelled = parcel.parcels.length > 0;
      return { outcome: 'ok', parcelCancelled, value: await apply(order, { parcelCancelled }) };
  });
}

// How the platform may rewrite a text it stored: case, spaces and punctuation do not make it another value.
const loose = (value) => String((typeof value === 'object' && value !== null ? JSON.stringify(value) : value) ?? '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const samePhone = (a, b) => String(a ?? '').replace(/\D/gu, '').slice(-9) === String(b ?? '').replace(/\D/gu, '').slice(-9);
const sameValue = (key, a, b) => (key.startsWith('recipient_phone') ? samePhone(a, b) : loose(a) === loose(b));
// Everything an edit sends back: none of it may move except what was asked.
const KEPT_FIELDS = ['recipient_name', 'recipient_phone', 'recipient_phone2', 'address', 'allow_opening', 'comment', 'city', 'product_name', 'cod_amount', 'is_fragile'];

function changedBeyond(before, after, patch) {
  const moved = KEPT_FIELDS.filter((key) => !(key in patch) && before[key] !== undefined && before[key] !== null && !sameValue(key, before[key], after[key]));
  if (Boolean(before.is_express ?? before.isExpress) !== Boolean(after.is_express ?? after.isExpress)) {
    moved.push('express');
  }
  if (Array.isArray(before.items) && before.items.length !== (Array.isArray(after.items) ? after.items.length : 0)) {
    moved.push('items');
  }
  return moved;
}

// Edits the order's parcel (if any), reads it back to be sure the platform applied the change and nothing else moved,
// then runs `apply(freshOrder, { parcelEdited })`.
// -> { outcome: 'ok', value, parcelEdited, check } | { outcome: 'too_late' | 'failed' | 'unsure', detail }.
// "failed" means the parcel is certainly as before; "unsure" means it may carry the change.
export async function editParcelThen({ orderId, hdAutoSend = null, wooClient, patch, apply, logger = console }) {
  return withParcelHeld({ orderId, hdAutoSend, wooClient, logger }, async (order, hdClient) => {
    const parcel = await inspectParcel(order, hdClient);
    if (parcel.state === 'collected') {
      return { outcome: 'too_late', detail: parcel.detail };
    }
    if (parcel.state === 'unverified') {
      return { outcome: 'failed', detail: parcel.detail };
    }
    const moved = new Set();
    let touched = false;
    for (const row of parcel.parcels) {
      const rowId = row.id ?? row._id;
      let lost = null;
      try {
        await hdClient.updatePackage(row, patch);
      } catch (error) {
        if (!error?.ambiguous) {
          return { outcome: touched ? 'unsure' : 'failed', detail: `HighDelivery refused the change: ${error.message}` };
        }
        lost = error;
      }
      const after = await hdClient.listPackages().then((rows) => rows.find((item) => (item.id ?? item._id) === rowId), () => null);
      if (!after || !Object.entries(patch).every(([key, value]) => sameValue(key, after[key], value))) {
        return { outcome: 'unsure', detail: lost ? `no answer from HighDelivery: ${lost.message}` : 'HighDelivery does not show the change' };
      }
      touched = true;
      changedBeyond(row, after, patch).forEach((field) => moved.add(field));
    }
    const parcelEdited = parcel.parcels.length > 0;
    let value;
    try {
      value = await apply(order, { parcelEdited });
    } catch (error) {
      if (!parcelEdited) {
        throw error;
      }
      return { outcome: 'unsure', detail: `the parcel is changed but WooCommerce was not saved: ${error.message}` };
    }
    if (moved.size) {
      logger.warn(`[manage] HighDelivery changed more than asked orderId=${orderId} fields=${[...moved].join(',')}`);
    }
    return { outcome: 'ok', parcelEdited, value, check: moved.size ? `HighDelivery a aussi change : ${[...moved].join(', ')}` : '' };
  });
}
