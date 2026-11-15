import { isQuietHours } from '../utils/quiet-hours.js';

const MAX_RUNS = 48;
const MAX_NEEDS = 20;
// The hourly cron is late when its last run is older than this (checked only after the same time of uptime).
export const HOURLY_LATE_MS = 90 * 60 * 1000;
// Versions of what the desktop app reads from here: the /api answers, this health payload, the product link document.
export const CONTRACT = Object.freeze({ api: 1, health: 1, linkDoc: 1 });

// Remembers when each outside service last worked (passively, from the calls the service already makes) and keeps the
// summaries of the hourly runs. Nothing here calls Woo, HighDelivery or WhatsApp by itself.
export class HealthTracker {
  constructor({ store, now = () => new Date(), startedAt = null } = {}) {
    this.store = store;
    this.now = now;
    this.startedAt = (startedAt || now()).toISOString();
    this.services = new Map();
    // name -> true while the last call failed in a way that says the service is down (not a clean refusal of one
    // request, such as a customer number WhatsApp does not know). Feeds GET /health/ready only.
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
    this.down.set(name, false);
  }

  recordFail(name, error) {
    const entry = this.entry(name);
    this.down.set(name, isOutage(error));
    entry.lastFailAt = this.now().toISOString();
    // Only a short plain reason: never a token, URL or customer detail.
    entry.lastError = String(error?.message || error || 'error').replace(/https?:\/\/\S+/g, '').trim().slice(0, 120);
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
    return this.down.get(name) === true;
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
// or the last WhatsApp or WooCommerce call failed because that service is down.
export function buildReadiness({ config = {}, tracker = null, durableState = null, now = new Date(), lateMs = HOURLY_LATE_MS }) {
  const nowMs = now.getTime();
  const startedMs = Date.parse(tracker?.startedAt || '') || nowMs;
  const lastRunMs = Date.parse(tracker?.runs(1)?.[0]?.at || '') || 0;
  const hourly = nowMs - startedMs < lateMs || (lastRunMs > 0 && nowMs - lastRunMs <= lateMs);
  const checks = {
    config: (config.errors || []).length === 0,
    durableState: durableState ? Boolean(durableState.loaded) : true,
    hourly: tracker ? hourly : true,
    wasender: tracker ? !tracker.lastCallFailed('wasender') : true,
    woocommerce: tracker ? !tracker.lastCallFailed('woocommerce') : true
  };
  return { ok: Object.values(checks).every(Boolean), checks };
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
      quietHours: { enabled: quiet.enabled !== false, startHour: quiet.startHour, endHour: quiet.endHour, timeZone },
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
