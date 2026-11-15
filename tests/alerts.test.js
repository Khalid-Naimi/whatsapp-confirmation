import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { createAlerts } from '../src/services/alerts.js';
import { createTeamNotifier } from '../src/services/team-notifier.js';
import { WasenderClient } from '../src/services/wasender-client.js';
import { FILLER, hdRows, linkDoc, linkUnit, makeService, makeShop, simpleProduct, wooProduct, wooVariation } from './helpers/fake-shop.js';

const quiet = { log() {}, warn() {}, error() {} };
const HOUR = 60 * 60 * 1000;
const newStore = () => new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-')), 'db.json'), { logger: quiet });

function fakeWasender({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(payload) {
      if (fail) {
        throw new Error('Wasender did not answer');
      }
      sent.push(payload);
      return {};
    }
  };
}

test('the same key is sent once per window (6 hours by default), a new key or no key always goes out', async () => {
  let clock = 0;
  const wasender = fakeWasender();
  const { alert } = createAlerts({ wasenderClient: wasender, phones: ['+212600000001', '+212600000002'], logger: quiet, now: () => clock });
  assert.deepEqual(await alert({ key: 'a', text: 'one' }), { delivered: true, sent: 2, via: 'whatsapp', deduped: false });
  clock = 5 * HOUR;
  assert.equal((await alert({ key: 'a', text: 'again' })).deduped, true);
  assert.equal((await alert({ key: 'b', text: 'other' })).sent, 2);
  assert.equal((await alert({ text: 'no key' })).sent, 2);
  assert.equal((await alert({ text: 'no key' })).sent, 2);
  clock = 6 * HOUR + 1;
  assert.equal((await alert({ key: 'a', text: 'later' })).deduped, false);
  assert.equal(wasender.sent.length, 2 * 5);
  assert.ok(wasender.sent.every((message) => message.priority === 'low'));
});

test('a per-key window overrides the default, critical alerts use the normal lane', async () => {
  let clock = 0;
  const wasender = fakeWasender();
  const { alert } = createAlerts({ wasenderClient: wasender, phones: ['+212600000001'], logger: quiet, now: () => clock });
  await alert({ key: 'k', text: 'x', windowMs: 60000, level: 'critical' });
  clock = 61000;
  assert.equal((await alert({ key: 'k', text: 'x', windowMs: 60000 })).deduped, false);
  assert.deepEqual(wasender.sent.map((m) => m.priority), ['normal', 'low']);
});

test('two alerts with the same key at the same moment send once', async () => {
  const wasender = fakeWasender();
  const { alert } = createAlerts({ wasenderClient: wasender, phones: ['+212600000001'], logger: quiet, now: () => 0 });
  const results = await Promise.all([alert({ key: 'same', text: 'x' }), alert({ key: 'same', text: 'x' })]);
  assert.deepEqual(results.map((r) => r.deduped).sort(), [false, true]);
  assert.equal(wasender.sent.length, 1);
});

test('when WhatsApp fails the alert goes by email, and a total failure is not remembered (it is tried again)', async () => {
  const mails = [];
  let mailFails = false;
  const mailService = { async send(mail) { if (mailFails) { throw new Error('smtp down'); } mails.push(mail); } };
  const { alert } = createAlerts({ wasenderClient: fakeWasender({ fail: true }), phones: ['+212600000001'], mailService, mailTo: 'owner@example.com', logger: quiet, now: () => 0 });
  assert.deepEqual(await alert({ key: 'k', text: 'hello' }), { delivered: true, sent: 0, via: 'email', deduped: false });
  assert.deepEqual(mails, [{ to: 'owner@example.com', subject: 'Rhymat: alerte serveur', text: 'hello' }]);
  assert.equal((await alert({ key: 'k', text: 'hello' })).deduped, true);
  mailFails = true;
  assert.equal((await alert({ key: 'k2', text: 'x' })).delivered, false);
  mailFails = false;
  assert.equal((await alert({ key: 'k2', text: 'x' })).via, 'email');
});

test('the window is kept in the local store, so a new alerts object (same process store) remembers it', async () => {
  const store = newStore();
  const first = createAlerts({ wasenderClient: fakeWasender(), phones: ['+212600000001'], store, logger: quiet, now: () => 1000 });
  await first.alert({ key: 'stored', text: 'x' });
  assert.ok(store.read().alerts.stored);
  const wasender = fakeWasender();
  const second = createAlerts({ wasenderClient: wasender, phones: ['+212600000001'], store, logger: quiet, now: () => 2000 });
  assert.equal((await second.alert({ key: 'stored', text: 'x' })).deduped, true);
  assert.equal(wasender.sent.length, 0);
});

test('the team notifier goes through the alert path (low lane, email fallback) and never throws', async () => {
  const wasender = fakeWasender();
  const alerts = createAlerts({ wasenderClient: wasender, phones: ['+212600000001', '+212600000002'], logger: quiet });
  const notify = createTeamNotifier({ wasenderClient: wasender, phones: [], alerts, logger: quiet });
  assert.equal(await notify('hi'), 2);
  assert.deepEqual(wasender.sent[0], { to: '+212600000001', message: 'hi', priority: 'low' });
  const broken = createTeamNotifier({ wasenderClient: wasender, phones: [], alerts: { notify: async () => { throw new Error('x'); } }, logger: quiet });
  assert.equal(await broken('hi'), 0);
});

test('Wasender sends customer messages before waiting routine team notices', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = new WasenderClient({
    baseUrl: 'https://wa.example/api',
    apiToken: 'token',
    minIntervalMs: 0,
    logger: quiet,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      order.push(body.text);
      if (body.text === 'first') {
        await gate;
      }
      return { ok: true, status: 200, async text() { return '{"success":true}'; } };
    }
  });
  const sends = [
    client.sendMessage({ to: '+212600000001', message: 'first' }),
    client.sendMessage({ to: '+212600000009', message: 'team 1', priority: 'low' }),
    client.sendMessage({ to: '+212600000009', message: 'team 2', priority: 'low' }),
    client.sendMessage({ to: '+212600000002', message: 'customer' })
  ];
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(client.queued(), { normal: 1, low: 2 });
  release();
  await Promise.all(sends);
  assert.deepEqual(order, ['first', 'customer', 'team 1', 'team 2']);
});

// --- stock sync: the unresolved-order alert is deduplicated, the abort alert goes through the same path ---

const orderFor = (productId, variationId = 0, id = 31) => ({ id, status: 'processing', line_items: [{ name: `Line ${productId}`, quantity: 1, product_id: productId, variation_id: variationId }], meta_data: [] });

test('the hourly unresolved-order alert is told once per 6 hours for the same lines', async () => {
  const product = wooProduct(7, { type: 'variable', doc: linkDoc({ 71: linkUnit({ items: [{ hd_id: 24, hd_name: 'HD 24', qty: 1 }] }) }) });
  const variations = { 7: [wooVariation(71, 'a', { stock: 0 }), wooVariation(79, 'new', { stock: 0 })] };
  const shop = makeShop({ products: [product, simpleProduct(101, 25, { stock: 0 })], variations, hd: [...FILLER, ...hdRows([24, 3], [25, 3])], orders: [orderFor(7, 79)] });
  const wasender = fakeWasender();
  let clock = Date.parse('2026-11-15T10:00:00Z');
  const alerts = createAlerts({ wasenderClient: wasender, phones: ['+212600000001'], logger: quiet, now: () => clock });
  await makeService(shop, { alert: alerts.alert }).run();
  await makeService(shop, { alert: alerts.alert }).run();
  assert.equal(wasender.sent.length, 1);
  assert.match(wasender.sent[0].message, /synchro du stock en pause/u);
  clock += 7 * HOUR;
  await makeService(shop, { alert: alerts.alert }).run();
  assert.equal(wasender.sent.length, 2);
});

test('a stock sync abort is told through the alert path with its own key', async () => {
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 0 })], hd: [] });
  const calls = [];
  const result = await makeService(shop, { alert: async (call) => { calls.push(call); return { delivered: true, sent: 1 }; } }).run();
  assert.equal(result.summary.aborted, 'hd_empty');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'stock-sync-abort:hd_empty');
  assert.match(calls[0].text, /synchro du stock arretee/u);
});

// --- the hourly task: a failure alerts once ---

function post(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url, headers, on(event, callback) { if (event === 'end') { setImmediate(callback); } return this; } };
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    handler(req, res);
  });
}

test('a failed hourly run alerts the team once per window', async () => {
  const wasender = fakeWasender();
  const alerts = createAlerts({ wasenderClient: wasender, phones: ['+212600000001'], logger: quiet, now: () => 0 });
  const handler = createApp({
    config: { tasks: { secret: 's' } },
    confirmationService: { async runOrderFollowups() { throw new Error('Woo down'); } },
    store: newStore(),
    alerts,
    logger: quiet
  });
  assert.equal((await post(handler, '/tasks/order-followups', { 'x-task-secret': 's' })).status, 500);
  assert.equal((await post(handler, '/tasks/order-followups', { 'x-task-secret': 's' })).status, 500);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(wasender.sent.length, 1);
  assert.match(wasender.sent[0].message, /tache horaire/u);
  assert.equal(wasender.sent[0].priority, 'normal');
});
