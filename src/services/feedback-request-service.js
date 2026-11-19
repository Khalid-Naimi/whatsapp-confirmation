import { FEEDBACK_META_KEYS, FEEDBACK_TEST_META_KEYS, HD_STATUS_META } from '../domain/order-meta.js';
import { WOO_STATUS } from '../domain/order-states.js';
import { DEFAULT_WOO_STATUSES, foldHdStatus } from '../utils/hd-status.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function metaValue(order, key) {
  const row = (order?.meta_data || []).find((item) => item?.key === key);
  return row ? String(row.value ?? '').trim() : '';
}

// Sends the feedback request (and the invitation to send a video, see FEEDBACK_REQUEST_MESSAGE) once to every customer
// whose parcel was delivered `delayDays` ago. Runs in the hourly task, after the HighDelivery status sync.
//
// An order is asked when ALL of these hold:
//  - its HighDelivery status is "delivered" and that was saved between `from` and now - delayDays (so turning this on
//    never messages old orders, and an order that was missed is not asked weeks later: `maxAgeDays`);
//  - nobody asked it before (no feedback request time or token on the order, no sent record);
//  - the customer is not opted out and the shop is not in quiet hours (sendFeedbackRequest checks both).
export class FeedbackRequestService {
  constructor({ confirmationService, wooClient, config = {}, wooStatuses = DEFAULT_WOO_STATUSES, logger = console }) {
    this.confirmationService = confirmationService;
    this.wooClient = wooClient;
    this.config = config;
    this.wooStatuses = { ...DEFAULT_WOO_STATUSES, ...(wooStatuses || {}) };
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.config.enabled);
  }

  isDue(order, now) {
    if (foldHdStatus(metaValue(order, HD_STATUS_META.status)) !== 'delivered') {
      return false;
    }
    const deliveredAt = Date.parse(metaValue(order, HD_STATUS_META.statusAt));
    const from = Date.parse(this.config.from || '');
    if (!Number.isFinite(deliveredAt) || (Number.isFinite(from) && deliveredAt < from)) {
      return false;
    }
    const age = now.getTime() - deliveredAt;
    if (age < (this.config.delayDays ?? 3) * DAY_MS || age > (this.config.maxAgeDays ?? 14) * DAY_MS) {
      return false;
    }
    return !(
      metaValue(order, FEEDBACK_TEST_META_KEYS.requestedAt)
      || metaValue(order, FEEDBACK_TEST_META_KEYS.sentAt)
      || metaValue(order, FEEDBACK_TEST_META_KEYS.token)
      || metaValue(order, FEEDBACK_META_KEYS.state)
    );
  }

  async run({ now = new Date() } = {}) {
    const summary = { checked: 0, due: 0, sent: 0, deferred: 0, skipped: 0, errors: 0 };
    if (!this.enabled) {
      return { ...summary, disabled: true };
    }
    const maxAgeMs = (this.config.maxAgeDays ?? 14) * DAY_MS;
    let orders;
    try {
      const statuses = [...new Set([this.wooStatuses.delivered, WOO_STATUS.delivered, WOO_STATUS.completed].filter(Boolean))];
      orders = await this.confirmationService.listOrdersForStatuses(statuses, {
        after: new Date(now.getTime() - maxAgeMs - 30 * DAY_MS).toISOString()
      });
    } catch (error) {
      this.logger.warn(`[feedback-request] could not load orders: ${error.message}`);
      return { ...summary, errors: 1 };
    }
    const maxPerRun = this.config.maxPerRun ?? 30;
    for (const order of orders) {
      summary.checked += 1;
      if (!this.isDue(order, now)) {
        continue;
      }
      summary.due += 1;
      if (summary.sent >= maxPerRun) {
        break;
      }
      try {
        const outcome = await this.confirmationService.withOrderLock(String(order.id), async () => {
          // Look at the order again right before the message: an overlapping run may have sent it a moment ago.
          const fresh = (await this.wooClient.getOrder(String(order.id))) || order;
          if (!this.isDue(fresh, now)) {
            return { sent: false, reason: 'not_due' };
          }
          return this.confirmationService.sendFeedbackRequest(fresh, now);
        });
        if (outcome.sent) {
          summary.sent += 1;
        } else if (outcome.reason === 'quiet_hours') {
          summary.deferred += 1;
          break; // the whole run is in quiet hours: the next hourly run tries again
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        summary.errors += 1;
        this.logger.warn(`[feedback-request] orderId=${order.id} failed: ${error.message}`);
      }
    }
    this.logger.log(`[feedback-request] completed ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    return summary;
  }
}
