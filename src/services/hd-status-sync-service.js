import { HD_META, HD_STATUS_META } from '../domain/order-meta.js';
import { HD_SYNC_WOO_STATUSES, NO_STAGE_MESSAGE_WOO_STATUSES } from '../domain/order-states.js';
import { DEFAULT_WOO_STATUSES, HD_FINAL_STATUSES, customerStageFor, foldHdStatus, wooStatusChange } from '../utils/hd-status.js';

// Order fields written by this sync (domain/order-meta.js).
export { HD_STATUS_META };

const SYNC_WOO_STATUSES = HD_SYNC_WOO_STATUSES;
// Only parcels sent to HighDelivery in the last 30 days are synced or messaged. Turning the sync on therefore never
// rewrites old orders (restock-on-cancel, reports) or messages customers about old parcels, and the order list stays short.
const SYNC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Woo filters by creation date; a parcel is sent shortly after its order, so look back a little further.
const LIST_LOOKBACK_MS = SYNC_MAX_AGE_MS + 14 * 24 * 60 * 60 * 1000;

function metaValue(order, key) {
  const row = (order?.meta_data || []).find((item) => item?.key === key);
  return row ? String(row.value ?? '') : '';
}

function metaUpdate(order, key, value) {
  const existing = (order?.meta_data || []).find((item) => item?.key === key);
  return existing?.id ? { id: existing.id, key, value } : { key, value };
}

// Reads every parcel's status from HighDelivery and, for orders this service sent, keeps WooCommerce in step:
// the status is stored in the order, an order note records each change, delivered and cancelled/returned parcels
// close the order, and the customer gets one "shipped" and one "arriving" message (never in the quiet hours).
export class HdStatusSyncService {
  constructor({ confirmationService, wooClient, hdClient, enabled = true, wooStatuses = DEFAULT_WOO_STATUSES, logger = console }) {
    this.confirmationService = confirmationService;
    this.wooClient = wooClient;
    this.hdClient = hdClient;
    this.enabled = enabled;
    this.wooStatuses = { ...DEFAULT_WOO_STATUSES, ...(wooStatuses || {}) };
    this.logger = logger;
  }

  async run({ now = new Date() } = {}) {
    const summary = { checked: 0, changed: 0, wooUpdated: 0, messagesSent: 0, messagesDeferred: 0, skipped: 0, errors: 0 };
    if (!this.enabled || !this.hdClient?.isConfigured?.()) {
      return { ...summary, disabled: true };
    }

    let packages;
    let orders;
    try {
      [packages, orders] = await Promise.all([
        this.hdClient.listPackages(),
        this.confirmationService.listOrdersForStatuses(SYNC_WOO_STATUSES, { after: new Date(now.getTime() - LIST_LOOKBACK_MS).toISOString() })
      ]);
    } catch (error) {
      this.logger.warn(`[hd-status] could not load parcels or orders: ${error.message}`);
      return { ...summary, errors: 1 };
    }

    const byTracking = new Map();
    for (const parcel of packages) {
      const tracking = String(parcel?.tracking_number ?? parcel?.trackingNumber ?? '').trim().toUpperCase();
      if (tracking) {
        byTracking.set(tracking, parcel);
      }
    }

    for (const order of orders) {
      const tracking = metaValue(order, HD_META.tracking).trim().toUpperCase();
      const sentAt = Date.parse(metaValue(order, HD_META.sentAt));
      if (!tracking || !Number.isFinite(sentAt) || now.getTime() - sentAt > SYNC_MAX_AGE_MS) {
        continue;
      }
      const previous = foldHdStatus(metaValue(order, HD_STATUS_META.status));
      // A parcel that already reached an end state needs a visit only if its Woo status still has to catch up
      // (for example the earlier status write failed).
      if (HD_FINAL_STATUSES.has(previous) && !wooStatusChange(previous, order.status, this.wooStatuses)) {
        continue;
      }
      summary.checked += 1;
      const parcel = byTracking.get(tracking);
      if (!parcel && !HD_FINAL_STATUSES.has(previous)) {
        summary.skipped += 1;
        continue;
      }
      try {
        await this.confirmationService.withOrderLock(String(order.id), () => this.syncOrder(order, parcel, tracking, now, summary));
      } catch (error) {
        summary.errors += 1;
        this.logger.warn(`[hd-status] orderId=${order.id} failed: ${error.message}`);
      }
    }

    this.logger.log(`[hd-status] completed ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    return summary;
  }

  async syncOrder(order, parcel, tracking, now, summary) {
    const orderId = String(order.id);
    const previous = foldHdStatus(metaValue(order, HD_STATUS_META.status));
    const status = foldHdStatus(parcel?.status) || previous;
    let current = order;

    // 1. The Woo status first, and on every visit: if this write fails, the saved HighDelivery status is not updated
    //    either, so the next hourly run tries again.
    const target = wooStatusChange(status, order.status, this.wooStatuses);
    if (target) {
      await this.wooClient.updateOrderStatus(orderId, target);
      summary.wooUpdated += 1;
      current = { ...current, status: target };
    }

    // 2. Then the saved HighDelivery status and the note.
    if (status && status !== previous) {
      summary.changed += 1;
      const updated = await this.wooClient.updateOrderMeta(orderId, [
        metaUpdate(order, HD_STATUS_META.status, status),
        metaUpdate(order, HD_STATUS_META.statusAt, now.toISOString())
      ]);
      current = { ...(updated || order), status: current.status };
      await this.safeNote(orderId, `HighDelivery status: ${previous || 'unknown'} -> ${status} (${tracking}).`);
    }

    const stage = customerStageFor(status);
    if (!stage || NO_STAGE_MESSAGE_WOO_STATUSES.includes(String(current.status || ''))) {
      return;
    }
    // Look at the order again right before a customer message: an overlapping run may have sent it a moment ago.
    let fresh = current;
    try {
      fresh = (await this.wooClient.getOrder(orderId)) || current;
    } catch (error) {
      this.logger.warn(`[hd-status] could not re-read orderId=${orderId}: ${error.message}`);
      return;
    }
    if (NO_STAGE_MESSAGE_WOO_STATUSES.includes(String(fresh.status || ''))) {
      return;
    }
    const outcome = await this.confirmationService.sendHdStageMessage(fresh, stage, tracking, now);
    if (outcome.sent) {
      summary.messagesSent += 1;
    } else if (outcome.reason === 'quiet_hours') {
      summary.messagesDeferred += 1;
    }
  }

  async safeNote(orderId, note) {
    try {
      await this.wooClient.addOrderNote(orderId, note);
    } catch (error) {
      this.logger.warn(`[hd-status] note failed orderId=${orderId}: ${error.message}`);
    }
  }
}
