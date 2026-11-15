import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { HealthTracker, buildHealthDetails, buildReadiness, trackCalls } from '../src/services/health-tracker.js';

const quiet = { log() {}, warn() {}, error() {} };
const START = new Date('2026-11-15T10:00:00Z');
const minutes = (n) => new Date(START.getTime() + n * 60000);
const newStore = () => new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-')), 'db.json'), { logger: quiet });

function setup({ at = START, errors = [], loaded = true } = {}) {
  let clock = at;
  const tracker = new HealthTracker({ store: newStore(), now: () => clock, startedAt: START });
  return {
    tracker,
    config: { errors, tasks: { secret: 's' } },
    durableState: { loaded },
    setNow: (date) => { clock = date; }
  };
}

test('ready when everything is fine, also before the first hourly run during the first 90 minutes', () => {
  const { tracker, config, durableState } = setup();
  assert.deepEqual(buildReadiness({ config, tracker, durableState, now: minutes(80) }), {
    ok: true,
    checks: { config: true, durableState: true, hourly: true, wasender: true, woocommerce: true }
  });
});

test('not ready with config errors or opt-outs not loaded', () => {
  const a = setup({ errors: ['TASK_SECRET is missing'] });
  assert.equal(buildReadiness({ ...a, now: minutes(1) }).checks.config, false);
  const b = setup({ loaded: false });
  const result = buildReadiness({ ...b, now: minutes(1) });
  assert.deepEqual([result.ok, result.checks.durableState], [false, false]);
});

test('the hourly run is late after 90 minutes of uptime without a run, or when the last run is older than 90 minutes', () => {
  const ctx = setup();
  assert.equal(buildReadiness({ ...ctx, now: minutes(91) }).checks.hourly, false);
  ctx.setNow(minutes(100));
  ctx.tracker.recordRun({ ok: false, error: 'boom' });
  assert.equal(buildReadiness({ ...ctx, now: minutes(150) }).checks.hourly, true);
  assert.equal(buildReadiness({ ...ctx, now: minutes(191) }).checks.hourly, false);
});

test('a failed Wasender or Woo call makes it not ready until the next success; a clean 4xx refusal does not', async () => {
  const ctx = setup();
  let fail = null;
  const wasender = { async sendMessageWithRetries() { if (fail) { throw fail; } return {}; } };
  trackCalls(wasender, 'wasender', ['sendMessageWithRetries'], ctx.tracker);
  fail = Object.assign(new Error('Wasender send-message failed with 422'), { status: 422 });
  await assert.rejects(wasender.sendMessageWithRetries());
  assert.equal(buildReadiness({ ...ctx, now: minutes(1) }).checks.wasender, true);
  fail = Object.assign(new Error('no answer'), { status: 0 });
  await assert.rejects(wasender.sendMessageWithRetries());
  assert.equal(buildReadiness({ ...ctx, now: minutes(1) }).checks.wasender, false);
  fail = null;
  await wasender.sendMessageWithRetries();
  assert.equal(buildReadiness({ ...ctx, now: minutes(1) }).checks.wasender, true);

  const woo = { async request() { throw new Error('WooCommerce request failed with 503: empty body'); } };
  trackCalls(woo, 'woocommerce', ['request'], ctx.tracker);
  await assert.rejects(woo.request());
  assert.equal(buildReadiness({ ...ctx, now: minutes(1) }).checks.woocommerce, false);
});

function get(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    handler({ method: 'GET', url, headers }, res);
  });
}

test('GET /health stays {ok:true}; GET /health/ready needs no secret, answers 503 when not ready and holds booleans only', async () => {
  const store = newStore();
  store.upsertOrder({ orderId: '9', phone: '+212600000009', customerName: 'Someone' });
  const tracker = new HealthTracker({ store, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
  const handler = createApp({ config: { errors: [], tasks: { secret: 's' } }, confirmationService: {}, store, healthTracker: tracker, durableState: { loaded: true }, logger: quiet });
  assert.deepEqual(await get(handler, '/health'), { status: 200, body: { ok: true } });
  const late = await get(handler, '/health/ready');
  assert.equal(late.status, 503);
  assert.equal(late.body.checks.hourly, false);
  for (const value of Object.values(late.body.checks)) {
    assert.equal(typeof value, 'boolean');
  }
  assert.doesNotMatch(JSON.stringify(late.body), /Someone|\+2126/u);
  tracker.recordRun({ ok: true });
  assert.equal((await get(handler, '/health/ready')).status, 200);
});

test('the authenticated health details carry the contract versions', () => {
  const store = newStore();
  const tracker = new HealthTracker({ store });
  const details = buildHealthDetails({ store, tracker, config: { messages: {} } });
  assert.deepEqual(details.contract, { api: 1, health: 1, linkDoc: 1 });
});
