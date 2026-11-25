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

// Cancels the order's parcel (if any) and then runs `apply(freshOrder, { parcelCancelled })`, which changes the order,
// while the auto-send (in memory) and any other sender (the claim) are held off.
// `precheck(order)` (optional) runs before any parcel is cancelled; a text it returns stops everything.
// -> { outcome: 'ok', value, parcelCancelled } | { outcome: 'too_late' | 'failed', detail }. A throw from apply passes.
export async function cancelParcelThen({ orderId, hdAutoSend = null, wooClient, reason = '', precheck = null, apply, logger = console }) {
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
      const hdClient = hdAutoSend?.hdClient || null;
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
