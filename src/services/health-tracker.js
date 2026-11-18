import { redact } from '../log.js';
import { isQuietHours } from '../utils/quiet-hours.js';

const MAX_RUNS = 48;
const MAX_NEEDS = 20;
// The hourly cron is late when its last run is older than this (checked only after the same time of uptime).
export const HOURLY_LATE_MS = 90 * 60 * 1000;
// Versions of what the desktop app reads from here: the /api answers, this health payload, the product link document.
export const CONTRACT = Object.freeze({ api: 1, health: 1, linkDoc: 1 });
// A Wasender / WooCommerce outage only makes /health/ready fail after 2 outage failures in a row, or when the first of
// them is at least this old with no success since: one dropped request is not an outage.
export const OUTAGE_MIN_FAILURES = 2;
export const OUTAGE_MIN_AGE_MS = 2 * 60 * 1000;

// Remembers when each outside service last worked (passively, from the calls the service already makes) and keeps the
// summaries of the hourly runs. Nothing here calls Woo, HighDelivery or WhatsApp by itself.
export class HealthTracker {
  constructor({ store, now = () => new Date(), startedAt = null } = {}) {
    this.store = store;
    this.now = now;
    this.startedAt = (startedAt || now()).toISOString();
    this.services = new Map();
    // name -> { count, sinceMs } of the outage failures in a row since the last success (a clean refusal of one request,
    // such as a customer number WhatsApp does not know, counts as an answer). Feeds GET /health/ready only.
    this.down = new Map();
  }

  entry(name) {
    if (!this.services.has(name)) {
      this.services.set(name, { lastOkAt: '', lastFailAt: '', lastError: '' });
    }
    return this.services.get(name);
  }

  recordOk(name) {
    this.entry(name).lastOkAt = this.now().toISOString();
    this.down.delete(name);
  }

  recordFail(name, error) {
    const entry = this.entry(name);
    if (isOutage(error)) {
      const previous = this.down.get(name);
      this.down.set(name, { count: (previous?.count || 0) + 1, sinceMs: previous?.sinceMs ?? this.now().getTime() });
    } else {
      this.down.delete(name);
    }
    entry.lastFailAt = this.now().toISOString();
    // Only a short plain reason: never a token, URL or customer detail.
    entry.lastError = redact(String(error?.message || error || 'error').replace(/https?:\/\/\S+/g, '')).trim().slice(0, 120);
  }

  // -> the time stamp of the new run, so a later result of that run can be attached to it.
  recordRun(run) {
    const at = this.now().toISOString();
    this.store.transaction((db) => {
      db.health = db.health || { runs: [] };
      db.health.runs.push({ at, ...run });
      db.health.runs = db.health.runs.slice(-MAX_RUNS);
    });
    return at;
  }

  // Adds fields to a run that was recorded earlier (the stock sync ends after the follow-ups are recorded).
  attachToRun(at, fields) {
    this.store.transaction((db) => {
      const run = (db.health?.runs || []).find((candidate) => candidate.at === at);
      if (run) {
        Object.assign(run, fields);
      }
    });
  }

  // true when the last call to that service failed because the service (or our access to it) is down.
  lastCallFailed(name) {
    return Boolean(this.down.get(name));
  }

  // true when the service counts as down: 2 outage failures in a row, or one older than 2 minutes, no success since.
  isDown(name, now = this.now()) {
    const outage = this.down.get(name);
    if (!outage) {
      return false;
    }
    return outage.count >= OUTAGE_MIN_FAILURES || now.getTime() - outage.sinceMs >= OUTAGE_MIN_AGE_MS;
  }

  runs(limit = 24) {
    const runs = this.store.read().health?.runs || [];
    return runs.slice(-limit);
  }
}

// A clean 4xx refusal of one request (bad customer number, unknown order) says the service answered: not an outage.
// No answer, 5xx, 429, 401/403 (our access) and Wasender's 200 "success:false" (session disconnected) are.
function isOutage(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status) || status === 0) {
    const match = String(error?.message || '').match(/failed with (\d{3})/u);
    if (!match) {
      return true;
    }
    return isOutageStatus(Number(match[1]));
  }
  return isOutageStatus(status);
}

function isOutageStatus(status) {
  return !(status >= 400 && status < 500) || [401, 403, 429].includes(status);
}

// GET /health/ready: booleans only, no customer data, no secret needed. ok is false (503) when the configuration has
// errors, the durable state (opt-outs) is not loaded, the hourly cron is late (after the first 90 minutes of uptime),
// or WhatsApp or WooCommerce is down (2 outage failures in a row, or one older than 2 minutes; see isDown).
// A missing control product (the desktop app has not created it yet) is not ready too: opt-outs would be kept only
// until the next restart. The team also gets one critical alert when it is first seen (services/durable-state.js).
export function buildReadiness({ config = {}, tracker = null, durableState = null, now = new Date(), lateMs = HOURLY_LATE_MS, queueStats = null }) {
  const nowMs = now.getTime();
  const startedMs = Date.parse(tracker?.startedAt || '') || nowMs;
  const lastRunMs = Date.parse(tracker?.runs(1)?.[0]?.at || '') || 0;
  const hourly = nowMs - startedMs < lateMs || (lastRunMs > 0 && nowMs - lastRunMs <= lateMs);
  const checks = {
    config: (config.errors || []).length === 0,
    durableState: durableState ? Boolean(durableState.loaded) : true,
    hourly: tracker ? hourly : true,
    wasender: tracker ? !tracker.isDown('wasender', now) : true,
    woocommerce: tracker ? !tracker.isDown('woocommerce', now) : true
  };
  const ok = Object.values(checks).every(Boolean);
  const result = { ok, status: ok ? 'ready' : 'not_ready', checks };
  // Numbers only: how many WhatsApp messages wait in the send queue and how long the oldest has waited. A long queue is
  // slow, not broken, so it does not make the service not ready (the team gets an alert instead).
  if (queueStats) {
    const stats = queueStats() || {};
    result.queue = { waiting: Number(stats.waiting) || 0, oldestWaitSeconds: Math.round((Number(stats.oldestWaitMs) || 0) / 1000) };
  }
  return result;
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

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// "Needs you" rows for the stock sync and the product links. Same row shape as the order rows, without an order id.
function stockSyncNeeds(snapshot) {
  const at = snapshot.lastRun?.at || '';
  const needs = [];
  const { lastRun } = snapshot;
  if (lastRun?.aborted) {
    const followUp = snapshot.approvable ? 'Check and approve in Matching.' : 'Nothing was written.';
    needs.push({ kind: 'stock_sync_aborted', reason: `Stock sync stopped: ${lastRun.abortDetail || lastRun.aborted}. ${followUp}`, at });
  }
  if (snapshot.mode.controlProblem && snapshot.mode.env !== 'off') {
    needs.push({ kind: 'sync_control_problem', reason: `The sync control record cannot be read (${snapshot.mode.controlProblem}). The stock sync does not write.`, at });
  }
  const unlinked = snapshot.unlinked.products + snapshot.unlinked.hd;
  if (unlinked > 0) {
    needs.push({ kind: 'unlinked_products', reason: `${plural(unlinked, 'new product needs', 'new products need')} a match.`, at });
  }
  if (snapshot.badDocs > 0) {
    needs.push({ kind: 'bad_link_doc', reason: `${plural(snapshot.badDocs, 'product link document cannot', 'product link documents cannot')} be read.`, at });
  }
  return needs;
}

function stockSyncBlock(snapshot) {
  const { lastRun } = snapshot;
  return {
    mode: { env: snapshot.mode.env, paused: snapshot.mode.paused, effective: snapshot.mode.effective },
    lastRun: lastRun ? { at: lastRun.at, changed: lastRun.changed, errors: lastRun.errors, aborted: lastRun.aborted } : null,
    unlinked: { woo: snapshot.unlinked.woo, hd: snapshot.unlinked.hd },
    brokenLinks: snapshot.brokenLinks
  };
}

// The read-only picture the desktop app shows on its Backend health page.
export function buildHealthDetails({ store, tracker, config, stockSyncService = null, now = new Date() }) {
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

  const stockSync = stockSyncService?.healthSnapshot() || null;
  const allNeeds = [...(stockSync ? stockSyncNeeds(stockSync) : []), ...needs];

  const services = {};
  for (const name of ['woocommerce', 'highdelivery', 'wasender']) {
    services[name] = { ...tracker.entry(name) };
  }

  return {
    contract: { ...CONTRACT },
    generatedAt: now.toISOString(),
    server: {
      startedAt: tracker.startedAt,
      version: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7),
      quietHours: { enabled: quiet.enabled !== false, startHour: quiet.startHour, endHour: quiet.endHour, weekendEndHour: quiet.weekendEndHour, timeZone },
      quietNow: isQuietHours(now, quiet),
      statusSyncEnabled: Boolean(config.highDelivery?.statusSyncEnabled),
      autoSendEnabled: Boolean(config.highDelivery?.autoSendEnabled),
      stockSyncMode: config.stockSync?.mode || 'off'
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
    stockSync: stockSync ? stockSyncBlock(stockSync) : null,
    needs: allNeeds.slice(0, MAX_NEEDS)
  };
}
