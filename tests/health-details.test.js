import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { HealthTracker, buildHealthDetails, trackCalls } from '../src/services/health-tracker.js';

const NOW = new Date('2026-11-15T13:30:00Z');
const config = {
  tasks: { secret: 's3cret' },
  messages: { quietHours: { enabled: true, startHour: 22, endHour: 10, timeZone: 'Africa/Casablanca' } },
  highDelivery: { statusSyncEnabled: true, autoSendEnabled: true }
};
const newStore = () => new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'health-')), 'db.json'));

test('tracker notes the last success and a short, clean failure reason', async () => {
  const tracker = new HealthTracker({ store: newStore(), now: () => NOW });
  const client = { async request(ok) { if (!ok) { throw new Error('boom https://secret.example/x?token=abc'); } return 'fine'; } };
  trackCalls(client, 'woocommerce', ['request'], tracker);
  assert.equal(await client.request(true), 'fine');
  await assert.rejects(client.request(false));
  const entry = tracker.entry('woocommerce');
  assert.equal(entry.lastOkAt, NOW.toISOString());
  assert.equal(entry.lastError, 'boom');
});

test('runs are stored and trimmed', () => {
  const tracker = new HealthTracker({ store: newStore(), now: () => NOW });
  for (let i = 0; i < 60; i += 1) { tracker.recordRun({ ok: true, summary: { remindersSent: i } }); }
  assert.equal(tracker.runs(24).length, 24);
  assert.equal(tracker.store.read().health.runs.length, 48);
});

test('details count today in Morocco time and list orders held for a human', () => {
  const store = newStore();
  const tracker = new HealthTracker({ store, now: () => NOW });
  store.upsertOrder({ orderId: '1', createdAt: '2026-11-15T09:00:00Z', confirmationSentAt: '2026-11-15T09:01:00Z', decision: 'confirmed', decisionAt: '2026-11-15T09:10:00Z', hdAutoSentAt: '2026-11-15T09:11:00Z' });
  store.upsertOrder({ orderId: '2', createdAt: '2026-11-15T10:00:00Z', confirmationSentAt: '2026-11-15T10:01:00Z', decision: 'confirmed', decisionAt: '2026-11-15T10:20:00Z', hdOutcome: 'skipped', hdOutcomeReason: 'no_warehouse_match', hdOutcomeAt: '2026-11-15T10:21:00Z' });
  store.upsertOrder({ orderId: '3', createdAt: '2026-11-13T10:00:00Z', confirmationSentAt: '2026-11-13T10:01:00Z' });
  const details = buildHealthDetails({ store, tracker, config, now: NOW });
  assert.deepEqual(details.today, { ordersIn: 2, confirmationSent: 2, replied: 2, confirmed: 2, cancelled: 0, sentToHighDelivery: 1, delivered: 0 });
  assert.equal(details.needs.length, 1);
  assert.deepEqual([details.needs[0].orderId, details.needs[0].kind], ['2', 'manual']);
  assert.equal(details.server.quietNow, false);
});

function call(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    handler({ method: 'GET', url, headers }, res);
  });
}

test('the details route needs the task secret and exposes no customer data', async () => {
  const store = newStore();
  const tracker = new HealthTracker({ store, now: () => NOW });
  store.upsertOrder({ orderId: '2', phone: '+212600000000', customerName: 'Someone', hdOutcome: 'held', hdOutcomeAt: NOW.toISOString() });
  const handler = createApp({ config, confirmationService: {}, store, healthTracker: tracker, logger: { log() {}, warn() {}, error() {} } });
  assert.equal((await call(handler, '/api/health/details')).status, 401);
  const response = await call(handler, '/api/health/details', { 'x-task-secret': 's3cret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.needs[0].orderId, '2');
  assert.doesNotMatch(JSON.stringify(response.body), /Someone|\+2126/);
});

// --- stock sync block ---

const snapshot = (over = {}) => ({
  mode: { env: 'live', paused: false, effective: 'live', controlProblem: '' },
  lastRun: { at: '2026-11-15T13:00:00Z', changed: 3, errors: 0, aborted: '', abortDetail: '' },
  approvable: false,
  unlinked: { woo: 0, hd: 0, products: 0 },
  brokenLinks: 0,
  badDocs: 0,
  ...over
});
const detailsWith = (stock, extraConfig = {}) => {
  const store = newStore();
  const tracker = new HealthTracker({ store, now: () => NOW });
  return buildHealthDetails({ store, tracker, config: { ...config, stockSync: { mode: 'live' }, ...extraConfig }, stockSyncService: { healthSnapshot: () => stock }, now: NOW });
};

test('the details carry the stock sync block and the server mode', () => {
  const details = detailsWith(snapshot());
  assert.deepEqual(details.stockSync, {
    mode: { env: 'live', paused: false, effective: 'live' },
    lastRun: { at: '2026-11-15T13:00:00Z', changed: 3, errors: 0, aborted: '' },
    unlinked: { woo: 0, hd: 0 },
    brokenLinks: 0
  });
  assert.equal(details.server.stockSyncMode, 'live');
  assert.deepEqual(details.needs, []);
});

test('without a stock sync service the block is null and the mode is off', () => {
  const store = newStore();
  const details = buildHealthDetails({ store, tracker: new HealthTracker({ store, now: () => NOW }), config, now: NOW });
  assert.equal(details.stockSync, null);
  assert.equal(details.server.stockSyncMode, 'off');
});

test('an aborted run, new products, bad documents and a broken control record become "needs you" rows', () => {
  const aborted = detailsWith(snapshot({ lastRun: { at: 'a', changed: 0, errors: 0, aborted: 'too_many_changes', abortDetail: '14 units would change (limit 10)' }, approvable: true }));
  assert.deepEqual(aborted.needs.map((n) => n.kind), ['stock_sync_aborted']);
  assert.equal(aborted.needs[0].reason, 'Stock sync stopped: 14 units would change (limit 10). Check and approve in Matching.');

  const refused = detailsWith(snapshot({ lastRun: { at: 'a', changed: 0, errors: 0, aborted: 'hd_empty', abortDetail: 'HighDelivery returned no items' } }));
  assert.equal(refused.needs[0].reason, 'Stock sync stopped: HighDelivery returned no items. Nothing was written.');

  const rest = detailsWith(snapshot({ unlinked: { woo: 4, hd: 1, products: 1 }, badDocs: 2, mode: { env: 'live', paused: true, effective: 'dry_run', controlProblem: 'control_missing' } }));
  assert.deepEqual(rest.needs.map((n) => n.kind), ['sync_control_problem', 'unlinked_products', 'bad_link_doc']);
  assert.equal(rest.needs[1].reason, '2 new products need a match.');
  assert.equal(rest.needs[2].reason, '2 product link documents cannot be read.');
});

test('the details with a stock sync block contain no customer keys', () => {
  assert.doesNotMatch(JSON.stringify(detailsWith(snapshot({ unlinked: { woo: 1, hd: 1, products: 1 } }))), /"(billing|shipping|phone|email|address\w*)":/u);
});
