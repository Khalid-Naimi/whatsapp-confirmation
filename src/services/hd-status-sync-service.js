import { HD_META } from './hd-auto-send-service.js';
import { HD_FINAL_STATUSES, customerStageFor, foldHdStatus, wooStatusChange } from '../utils/hd-status.js';

// Order fields written by this sync.
export const HD_STATUS_META = {
  status: 'rhymat_hd_status',
  statusAt: 'rhymat_hd_status_at'
};

const SYNC_WOO_STATUSES = ['on-hold', 'processing', 'completed'];
// A customer message is only sent for a parcel that was sent to HighDelivery recently, so turning this on never
// messages customers about old parcels.
const MESSAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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
  constructor({ confirmationService, wooClient, hdClient, enabled = true, logger = console }) {
    this.confirmationService = confirmationService;
    this.wooClient = wooClient;
    this.hdClient = hdClient;
    this.enabled = enabled;
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
        this.confirmationService.listOrdersForStatuses(SYNC_WOO_STATUSES)
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
      if (!tracking || HD_FINAL_STATUSES.has(foldHdStatus(metaValue(order, HD_STATUS_META.status)))) {
        continue;
      }
      summary.checked += 1;
      const parcel = byTracking.get(tracking);
      if (!parcel) {
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
    const status = foldHdStatus(parcel.status);
    const previous = foldHdStatus(metaValue(order, HD_STATUS_META.status));
    let current = order;

    if (status && status !== previous) {
      summary.changed += 1;
      const updated = await this.wooClient.updateOrderMeta(orderId, [
        metaUpdate(order, HD_STATUS_META.status, status),
        metaUpdate(order, HD_STATUS_META.statusAt, now.toISOString())
      ]);
      current = updated || order;
      await this.safeNote(orderId, `HighDelivery status: ${previous || 'unknown'} -> ${status} (${tracking}).`);

      const target = wooStatusChange(status, order.status);
      if (target) {
        await this.wooClient.updateOrderStatus(orderId, target);
        summary.wooUpdated += 1;
        current = { ...current, status: target };
      }
    }

    const stage = customerStageFor(status);
    const sentAt = Date.parse(metaValue(order, HD_META.sentAt));
    const recent = Number.isFinite(sentAt) && now.getTime() - sentAt <= MESSAGE_MAX_AGE_MS;
    if (!stage || !recent || ['cancelled', 'refunded', 'failed'].includes(String(current.status || ''))) {
      return;
    }
    const outcome = await this.confirmationService.sendHdStageMessage(current, stage, tracking, now);
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
