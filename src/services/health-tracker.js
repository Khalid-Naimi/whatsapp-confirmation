import { isQuietHours } from '../utils/quiet-hours.js';

const MAX_RUNS = 48;
const MAX_NEEDS = 20;

// Remembers when each outside service last worked (passively, from the calls the service already makes) and keeps the
// summaries of the hourly runs. Nothing here calls Woo, HighDelivery or WhatsApp by itself.
export class HealthTracker {
  constructor({ store, now = () => new Date(), startedAt = null } = {}) {
    this.store = store;
    this.now = now;
    this.startedAt = (startedAt || now()).toISOString();
    this.services = new Map();
  }

  entry(name) {
    if (!this.services.has(name)) {
      this.services.set(name, { lastOkAt: '', lastFailAt: '', lastError: '' });
    }
    return this.services.get(name);
  }

  recordOk(name) {
    this.entry(name).lastOkAt = this.now().toISOString();
  }

  recordFail(name, error) {
    const entry = this.entry(name);
    entry.lastFailAt = this.now().toISOString();
    // Only a short plain reason: never a token, URL or customer detail.
    entry.lastError = String(error?.message || error || 'error').replace(/https?:\/\/\S+/g, '').trim().slice(0, 120);
  }

  recordRun(run) {
    this.store.transaction((db) => {
      db.health = db.health || { runs: [] };
      db.health.runs.push({ at: this.now().toISOString(), ...run });
      db.health.runs = db.health.runs.slice(-MAX_RUNS);
    });
  }

  runs(limit = 24) {
    const runs = this.store.read().health?.runs || [];
    return runs.slice(-limit);
  }
}

// Wraps the listed async methods of a client so each success or failure is noted. The client itself is unchanged.
export function trackCalls(client, name, methods, tracker) {
  for (const method of methods) {
    const original = client[method]?.bind(client);
    if (!original) {
      continue;
    }
    client[method] = async (...args) => {
      try {
        const result = await original(...args);
        tracker.recordOk(name);
        return result;
      } catch (error) {
        tracker.recordFail(name, error);
        throw error;
      }
    };
  }
  return client;
}

function dayKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const PROBLEM_TEXT = {
  low_trust: 'The customer number has a low trust score.',
  no_warehouse_match: 'The product has no matching item in HighDelivery stock.',
  invalid_order: 'The order data is incomplete.',
  stock_read_failed: 'HighDelivery stock could not be read.',
  failed: 'HighDelivery refused the order.',
  unknown: 'HighDelivery did not answer. Check before sending again.',
  error: 'Unexpected error while sending.'
};

// The read-only picture the desktop app shows on its Backend health page.
export function buildHealthDetails({ store, tracker, config, now = new Date() }) {
  const quiet = config.messages?.quietHours || {};
  const timeZone = quiet.timeZone || 'Africa/Casablanca';
  const today = dayKey(now, timeZone);
  const isToday = (value) => Boolean(value) && dayKey(value, timeZone) === today;
  const orders = store.listOrders();
  const count = (predicate) => orders.filter(predicate).length;

  const needs = [];
  for (const order of orders) {
    if (!['held', 'skipped', 'failed', 'unknown', 'error'].includes(order.hdOutcome) || !isToday(order.hdOutcomeAt)) {
      continue;
    }
    if (order.hdOutcome === 'skipped' && !['no_warehouse_match', 'invalid_order', 'stock_read_failed'].includes(order.hdOutcomeReason)) {
      continue;
    }
    const key = order.hdOutcome === 'held' ? 'low_trust' : (order.hdOutcome === 'skipped' ? order.hdOutcomeReason : order.hdOutcome);
    needs.push({
      orderId: String(order.orderId),
      kind: ['failed', 'unknown', 'error', 'stock_read_failed'].includes(key) ? 'failed' : 'manual',
      reason: PROBLEM_TEXT[key] || 'Needs a manual send.',
      at: order.hdOutcomeAt
    });
  }

  const services = {};
  for (const name of ['woocommerce', 'highdelivery', 'wasender']) {
    services[name] = { ...tracker.entry(name) };
  }

  return {
    generatedAt: now.toISOString(),
    server: {
      startedAt: tracker.startedAt,
      version: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7),
      quietHours: { enabled: quiet.enabled !== false, startHour: quiet.startHour, endHour: quiet.endHour, timeZone },
      quietNow: isQuietHours(now, quiet),
      statusSyncEnabled: Boolean(config.highDelivery?.statusSyncEnabled),
      autoSendEnabled: Boolean(config.highDelivery?.autoSendEnabled)
    },
    services,
    runs: tracker.runs(24),
    today: {
      ordersIn: count((o) => isToday(o.createdAt)),
      confirmationSent: count((o) => isToday(o.confirmationSentAt)),
      replied: count((o) => isToday(o.decisionAt)),
      confirmed: count((o) => o.decision === 'confirmed' && isToday(o.decisionAt)),
      cancelled: count((o) => o.decision === 'cancelled' && isToday(o.decisionAt)),
      sentToHighDelivery: count((o) => isToday(o.hdAutoSentAt)),
      delivered: count((o) => o.wooStatus === 'delivered' && isToday(o.updatedAt))
    },
    needs: needs.slice(0, MAX_NEEDS)
  };
}
