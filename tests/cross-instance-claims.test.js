// Two server instances at once (a deploy overlap): each has its own memory and in-memory locks, they share one
// WooCommerce. A customer message and a HighDelivery parcel must still go out once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { HD_META, HdAutoSendService } from '../src/services/hd-auto-send-service.js';
import { claim, parseClaim } from '../src/services/claim.js';

const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const messages = {
  confirmationTemplate: 'Confirmez {{orderId}}',
  reminderMessage: 'Rappel {{orderId}}',
  invalidReply: 'Repondez 1 ou 2',
  confirmedReply: 'Merci',
  cancelledReply: 'Annulee',
  internalNotifyPhones: [],
  internalConfirmedTemplate: 'ok {{orderId}}',
  internalCancelledTemplate: 'ko {{orderId}}',
  deliveryEtaCasablanca: '24h',
  deliveryEtaOtherCities: '48h',
  defaultCityLabel: 'Maghrib',
  confirmationDelayMs: 0
};

// One WooCommerce for everybody. Every call takes a few event-loop turns, so concurrent callers interleave the way two
// processes talking to the same shop would.
function sharedWoo(orders) {
  const live = new Map(orders.map((order) => [String(order.id), structuredClone(order)]));
  const writes = [];
  const woo = {
    async getOrder(id) {
      await tick();
      const order = live.get(String(id));
      if (!order) {
        throw new Error('not found');
      }
      return structuredClone(order);
    },
    async updateOrder(id, fields) {
      await tick();
      const order = live.get(String(id));
      if (fields.status) {
        order.status = fields.status;
      }
      for (const row of fields.meta_data || []) {
        writes.push({ id: String(id), key: row.key, value: row.value });
        const at = order.meta_data.findIndex((item) => item.key === row.key);
        if (at >= 0) {
          order.meta_data[at] = { ...order.meta_data[at], key: row.key, value: row.value };
        } else {
          order.meta_data.push({ key: row.key, value: row.value });
        }
      }
      await tick();
      return structuredClone(order);
    },
    async updateOrderMeta(id, rows) { return woo.updateOrder(id, { meta_data: rows }); },
    async updateOrderStatus(id, status) { return woo.updateOrder(id, { status }); },
    async addOrderNote() { await tick(); return {}; },
    async listOrdersByStatuses(statuses) { return [...live.values()].filter((order) => statuses.includes(order.status)).map((order) => structuredClone(order)); },
    async listOrders() { return []; }
  };
  const metaOf = (id, key) => live.get(String(id))?.meta_data.find((row) => row.key === key)?.value;
  return { woo, live, writes, metaOf };
}

function order(id, extra = {}) {
  return {
    id,
    status: 'processing',
    total: '100',
    billing: { first_name: 'Test', phone: `+2126000${String(id).padStart(5, '0')}`, state: 'Casablanca', address_1: 'Rue 1', city: 'Casablanca' },
    shipping: { first_name: 'Test', phone: '0612345678', city: 'Casablanca', address_1: 'Rue 1' },
    line_items: [{ name: 'Tee', quantity: 1 }],
    meta_data: [],
    ...extra
  };
}

function instance(woo, sends, name, { settleMs = 15 } = {}) {
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), `claim-${name}-`)), 'db.json'), { logger: quiet });
  return new ConfirmationService({
    store,
    wasenderClient: {
      async sendMessage(payload) { await tick(); sends.push({ ...payload, by: name }); return { id: `${name}-${sends.length}` }; },
      async sendPoll() { return {}; }
    },
    wooClient: woo,
    messages,
    claimSettleMs: settleMs,
    sleep,
    instanceId: `test-${name}`,
    logger: quiet
  });
}

test('two instances handling the same new order at once send the confirmation once', async () => {
  const { woo, metaOf } = sharedWoo([order(501)]);
  const sends = [];
  const a = instance(woo, sends, 'a');
  const b = instance(woo, sends, 'b');
  const payload = order(501);
  const [ra, rb] = await Promise.all([a.processWooOrder(payload, 'delivery-a'), b.processWooOrder(payload, 'delivery-b')]);
  assert.equal(sends.length, 1);
  assert.equal(metaOf(501, 'rhymat_whatsapp_confirmation_request_state'), 'sent');
  // The one that backed off says so like any other send already in flight.
  assert.ok([ra.body, rb.body].some((body) => body.duplicate === true && body.reason === 'confirmation_in_flight'));
});

test('an instance with a stale copy of the order does not send what another instance already sent', async () => {
  const { woo } = sharedWoo([order(502)]);
  const sends = [];
  const a = instance(woo, sends, 'a');
  const b = instance(woo, sends, 'b');
  await a.sendInitialConfirmation(order(502));
  assert.equal(sends.length, 1);
  // B still holds the order as the webhook delivered it (no meta): the fresh read before reserving stops it.
  const result = await b.sendInitialConfirmation(order(502));
  assert.equal(sends.length, 1);
  assert.equal(result.body.duplicate, true);
});

test('two instances sending the same reminder at once send it once', async () => {
  const sentAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const pending = order(503, {
    date_created_gmt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString().slice(0, 19),
    meta_data: [
      { key: 'rhymat_whatsapp_state', value: 'pending' },
      { key: 'rhymat_whatsapp_confirmation_sent_at', value: sentAt },
      { key: 'rhymat_whatsapp_reminder_count', value: 0 },
      { key: 'rhymat_whatsapp_confirmation_request_state', value: 'sent' }
    ]
  });
  const { woo, metaOf } = sharedWoo([pending]);
  const sends = [];
  const a = instance(woo, sends, 'a');
  const b = instance(woo, sends, 'b');
  const [sa, sb] = await Promise.all([a.runOrderFollowups(), b.runOrderFollowups()]);
  assert.equal(sends.length, 1);
  assert.equal(sa.remindersSent + sb.remindersSent, 1);
  assert.equal(metaOf(503, 'rhymat_whatsapp_reminder_1_state'), 'sent');
});

test('a clean send failure releases the claim, so the next try (any instance) can send', async () => {
  const { woo, metaOf } = sharedWoo([order(504)]);
  const sends = [];
  const failing = new ConfirmationService({
    store: new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-f-')), 'db.json'), { logger: quiet }),
    wasenderClient: { async sendMessage() { throw new Error('refused'); }, async sendPoll() { return {}; } },
    wooClient: woo,
    messages,
    claimSettleMs: 0,
    instanceId: 'test-f',
    logger: quiet
  });
  await failing.sendInitialConfirmation(order(504));
  assert.equal(metaOf(504, 'rhymat_whatsapp_confirmation_request_claim'), '');
  assert.equal(metaOf(504, 'rhymat_whatsapp_confirmation_request_state'), '');
  const other = instance(woo, sends, 'b', { settleMs: 0 });
  await other.sendInitialConfirmation(order(504));
  assert.equal(sends.length, 1);
});

function hdInstance(woo, created, name) {
  return new HdAutoSendService({
    hdClient: {
      isConfigured: () => true,
      async trustScore() { await tick(); return { score: 80, blacklisted: false }; },
      async createPackage(parcel) { await tick(); created.push({ ...parcel, by: name }); return { trackingNumber: `T-${name}` }; }
    },
    wooClient: woo,
    wasenderClient: { async sendMessage() { return {}; } },
    store: null,
    enabled: true,
    claimSettleMs: 15,
    sleep,
    instanceId: `test-${name}`,
    logger: quiet
  });
}

test('two instances auto-sending the same confirmed order at once create one parcel', async () => {
  const { woo, metaOf } = sharedWoo([order(601, { status: 'on-hold' })]);
  const created = [];
  const a = hdInstance(woo, created, 'a');
  const b = hdInstance(woo, created, 'b');
  const outcomes = await Promise.all([a.autoSend({ orderId: '601' }), b.autoSend({ orderId: '601' })]);
  assert.equal(created.length, 1);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['sent', 'skipped']);
  assert.equal(outcomes.find((outcome) => outcome.status === 'skipped').reason, 'claimed_elsewhere');
  assert.equal(metaOf(601, HD_META.state), 'sent');
});

test('an auto-send that starts while another instance holds the reservation does not send', async () => {
  const { woo } = sharedWoo([order(602, { status: 'on-hold' })]);
  const created = [];
  const a = hdInstance(woo, created, 'a');
  const b = hdInstance(woo, created, 'b');
  const first = a.autoSend({ orderId: '602' });
  await sleep(5); // a has written "sending" and is waiting on its claim
  const second = await b.autoSend({ orderId: '602' });
  await first;
  assert.equal(created.length, 1);
  assert.equal(second.status, 'skipped');
  assert.match(second.reason, /^already_sending$|^claimed_elsewhere$/u);
});

test('claim(): a live claim held by someone else is refused, an expired one is taken over', async () => {
  const { woo, metaOf } = sharedWoo([order(700)]);
  const first = await claim(woo, 700, 'rhymat_test_claim', { settleMs: 0, instanceId: 'one' });
  assert.equal(first.ok, true);
  const second = await claim(woo, 700, 'rhymat_test_claim', { settleMs: 0, instanceId: 'two' });
  assert.deepEqual([second.ok, second.reason], [false, 'held']);
  const later = await claim(woo, 700, 'rhymat_test_claim', { settleMs: 0, instanceId: 'two', ttlMs: 1, now: () => new Date(Date.now() + 1000) });
  assert.equal(later.ok, true);
  assert.equal(parseClaim(metaOf(700, 'rhymat_test_claim')).claimId, later.claimId);
  await later.release();
  assert.equal(metaOf(700, 'rhymat_test_claim'), '');
});

test('claim(): a competing claim that lands only after the first read-back is still caught by the second read', async () => {
  const { woo } = sharedWoo([order(701)]);
  const waits = [];
  const slowCompetitor = async (ms) => {
    waits.push(ms);
    if (waits.length === 2) {
      // Another instance's claim write arrives late, between our two read-backs.
      await woo.updateOrderMeta(701, [{ key: 'rhymat_test_claim', value: JSON.stringify({ state: 'x', claimId: 'other:1', at: new Date().toISOString() }) }]);
    }
  };
  const result = await claim(woo, 701, 'rhymat_test_claim', { instanceId: 'mine', sleep: slowCompetitor });
  assert.deepEqual(waits, [2000, 500]);
  assert.deepEqual([result.ok, result.reason], [false, 'lost']);
});

// The desktop app sends an order itself under its own claim (ids "desktop-..."), writing state and sent time.
function desktopSent(id, state) {
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return order(id, {
    status: 'on-hold',
    meta_data: [
      { key: 'rhymat_whatsapp_decision', value: 'confirmed' },
      { key: 'rhymat_whatsapp_decision_at', value: at },
      { key: 'rhymat_whatsapp_woo_sync_status', value: 'synced' },
      { key: 'rhymat_whatsapp_woo_sync_attempts', value: 2 },
      { key: HD_META.state, value: state },
      ...(state === 'sent' ? [{ key: HD_META.sentAt, value: at }] : []),
      { key: HD_META.claim, value: JSON.stringify({ state: 'sending', claimId: 'desktop-abc123', at }) }
    ]
  });
}

test('an order the desktop app sent (state sent or unknown, desktop claim) is never auto-sent or retried by the server', async () => {
  for (const state of ['sent', 'unknown']) {
    const { woo, writes } = sharedWoo([desktopSent(610, state)]);
    const created = [];
    const alerts = [];
    const hd = hdInstance(woo, created, 'srv');
    hd.notifyPhones = ['+212700000001'];
    hd.errorTemplate = 'ERR {{orderId}}';
    hd.manualTemplate = 'MAN {{orderId}}';
    hd.wasenderClient = { async sendMessage(payload) { alerts.push(payload); return {}; } };
    const outcome = await hd.autoSend({ orderId: '610' });
    assert.deepEqual(outcome, { status: 'skipped', reason: 'already_sent_by_desktop' });

    // The hourly one-time retry of a confirmed order does not start an auto-send either.
    const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-desk-')), 'db.json'), { logger: quiet });
    const service = new ConfirmationService({ store, wasenderClient: { async sendMessage() { return {}; } }, wooClient: woo, messages, hdAutoSend: hd, claimSettleMs: 0, logger: quiet });
    assert.equal(await service.maybeRetryHdAutoSend(await woo.getOrder(610)), false);
    await service.runOrderFollowups();
    await service.drain();

    assert.equal(created.length, 0);
    assert.equal(alerts.length, 0);
    assert.ok(!writes.some((row) => [HD_META.state, HD_META.claim, HD_META.retryAt].includes(row.key)), state);
  }
});

// The desktop app writes state='sending', sendingAt and its own claim right before it creates a parcel itself.
function desktopSending(id, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return order(id, {
    status: 'on-hold',
    meta_data: [
      { key: HD_META.state, value: 'sending' },
      { key: HD_META.sendingAt, value: at },
      { key: HD_META.claim, value: JSON.stringify({ state: 'sending', claimId: 'desktop-def456', at }) }
    ]
  });
}

function hdWithAlerts(woo, created) {
  const alerts = [];
  const notes = [];
  const hd = hdInstance(woo, created, 'srv');
  hd.notifyPhones = ['+212700000001'];
  hd.errorTemplate = 'ERR {{orderId}} {{problem}}';
  hd.manualTemplate = 'MAN {{orderId}}';
  hd.wasenderClient = { async sendMessage(payload) { alerts.push(payload); return {}; } };
  const addNote = woo.addOrderNote;
  woo.addOrderNote = async (id, note) => { notes.push(note); return addNote(id, note); };
  return { hd, alerts, notes };
}

test('a desktop "sending" older than 10 minutes becomes "unknown" with a note and one alert, like the server\'s own', async () => {
  const { woo, metaOf } = sharedWoo([desktopSending(620, 15)]);
  const { hd, alerts, notes } = hdWithAlerts(woo, []);
  assert.equal(await hd.reviewStuckSend(await woo.getOrder(620)), true);
  assert.equal(metaOf(620, HD_META.state), 'unknown');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /stopped half way/u);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /ERR 620/u);
  // The next hour sees "unknown": nothing again.
  assert.equal(await hd.reviewStuckSend(await woo.getOrder(620)), false);
  assert.equal(alerts.length, 1);
});

test('a fresh desktop "sending" (under 10 minutes) is left alone, and the server\'s auto-send skips it without an alert', async () => {
  const { woo, metaOf, writes } = sharedWoo([desktopSending(621, 2)]);
  const created = [];
  const { hd, alerts, notes } = hdWithAlerts(woo, created);
  assert.equal(await hd.reviewStuckSend(await woo.getOrder(621)), false);
  const outcome = await hd.autoSend({ orderId: '621' });
  assert.equal(outcome.status, 'skipped');
  assert.ok(['already_sending', 'claimed_elsewhere'].includes(outcome.reason), outcome.reason);
  assert.equal(created.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(notes.length, 0);
  assert.equal(metaOf(621, HD_META.state), 'sending');
  assert.equal(writes.length, 0);
});
