import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { HD_META } from '../src/services/hd-auto-send-service.js';
import { HdStatusSyncService, HD_STATUS_META } from '../src/services/hd-status-sync-service.js';
import { customerStageFor, wooStatusChange } from '../src/utils/hd-status.js';
import { isQuietHours, parseQuietHoursEnv } from '../src/utils/quiet-hours.js';

const QUIET = { enabled: true, startHour: 22, endHour: 10, timeZone: 'Africa/Casablanca' };
// Morocco is UTC+1 in November (outside Ramadan), so 21:00Z is 22:00 in the shop.
const at = (iso) => new Date(iso);

test('quiet hours: 22:00 to 10:00 shop time, edges included/excluded', () => {
  assert.equal(isQuietHours(at('2026-11-14T20:59:00Z'), QUIET), false, '21:59 local');
  assert.equal(isQuietHours(at('2026-11-14T21:00:00Z'), QUIET), true, '22:00 local');
  assert.equal(isQuietHours(at('2026-11-14T23:30:00Z'), QUIET), true, '00:30 local');
  assert.equal(isQuietHours(at('2026-11-15T08:59:00Z'), QUIET), true, '09:59 local');
  assert.equal(isQuietHours(at('2026-11-15T09:00:00Z'), QUIET), false, '10:00 local');
  assert.equal(isQuietHours(at('2026-11-15T12:00:00Z'), QUIET), false);
});

test('quiet hours: off when disabled or unset, and env parsing', () => {
  assert.equal(isQuietHours(at('2026-11-14T23:00:00Z'), null), false);
  assert.equal(isQuietHours(at('2026-11-14T23:00:00Z'), { ...QUIET, enabled: false }), false);
  assert.deepEqual(parseQuietHoursEnv({}), { enabled: true, startHour: 23, endHour: 9, weekendEndHour: 10, timeZone: 'Africa/Casablanca' });
  assert.deepEqual(parseQuietHoursEnv({ QUIET_HOURS_START: '22', QUIET_HOURS_END: '10', QUIET_HOURS_WEEKEND_END: '11', QUIET_HOURS_TIMEZONE: 'UTC' }), {
    enabled: true, startHour: 22, endHour: 10, weekendEndHour: 11, timeZone: 'UTC'
  });
  assert.equal(parseQuietHoursEnv({ QUIET_HOURS_ENABLED: 'no' }).enabled, false);
  assert.equal(parseQuietHoursEnv({ QUIET_HOURS_START: 'abc' }).startHour, 23);
});

// Default window: 23:00 to 09:00, and to 10:00 on Saturday and Sunday mornings (shop time, UTC+1 in November).
const DEFAULT_QUIET = parseQuietHoursEnv({});
test('quiet hours: 23:00 to 09:00 on weekdays, to 10:00 on Saturday and Sunday mornings', () => {
  // Mon 16 Nov 2026
  assert.equal(isQuietHours(at('2026-11-16T21:59:00Z'), DEFAULT_QUIET), false, 'Mon 22:59 local');
  assert.equal(isQuietHours(at('2026-11-16T22:00:00Z'), DEFAULT_QUIET), true, 'Mon 23:00 local');
  assert.equal(isQuietHours(at('2026-11-17T07:59:00Z'), DEFAULT_QUIET), true, 'Tue 08:59 local');
  assert.equal(isQuietHours(at('2026-11-17T08:00:00Z'), DEFAULT_QUIET), false, 'Tue 09:00 local');
  // Sat 14 Nov and Sun 15 Nov 2026: the morning lasts until 10:00
  assert.equal(isQuietHours(at('2026-11-14T08:30:00Z'), DEFAULT_QUIET), true, 'Sat 09:30 local');
  assert.equal(isQuietHours(at('2026-11-14T09:00:00Z'), DEFAULT_QUIET), false, 'Sat 10:00 local');
  assert.equal(isQuietHours(at('2026-11-15T08:30:00Z'), DEFAULT_QUIET), true, 'Sun 09:30 local');
  assert.equal(isQuietHours(at('2026-11-15T09:00:00Z'), DEFAULT_QUIET), false, 'Sun 10:00 local');
  // Monday morning after the weekend is back to 09:00
  assert.equal(isQuietHours(at('2026-11-16T08:00:00Z'), DEFAULT_QUIET), false, 'Mon 09:00 local');
  assert.equal(isQuietHours(at('2026-11-15T22:30:00Z'), DEFAULT_QUIET), true, 'Sun 23:30 local');
});

test('HighDelivery status to Woo status: only end states, only forward', () => {
  assert.equal(wooStatusChange('delivered', 'on-hold'), 'completed');
  assert.equal(wooStatusChange('delivered', 'processing'), 'completed');
  assert.equal(wooStatusChange('delivered', 'completed'), null);
  assert.equal(wooStatusChange('delivered', 'cancelled'), null, 'never reopen a cancelled order');
  assert.equal(wooStatusChange('returned', 'completed'), 'cancelled', 'a parcel that came back cancels the order');
  assert.equal(wooStatusChange('refused', 'on-hold'), 'cancelled');
  assert.equal(wooStatusChange('returned_by_driver', 'completed'), null, 'an in-between return step does not cancel the order');
  assert.equal(wooStatusChange('cancelled', 'cancelled'), null);
  for (const status of ['picked_up', 'in_transit', 'out_for_delivery', 'postponed', 'not_delivered', 'saved', 'nonsense']) {
    assert.equal(wooStatusChange(status, 'on-hold'), null, status);
  }
  assert.equal(wooStatusChange('  Delivered ', 'on-hold'), 'completed', 'tolerates case and spaces');
});

test('customer stages: shipped while on the way, arriving only at the door', () => {
  for (const status of ['picked_up', 'in_hub', 'dispatched_to_runsheet', 'in_transit']) assert.equal(customerStageFor(status), 'shipped', status);
  assert.equal(customerStageFor('out_for_delivery'), 'arriving');
  for (const status of ['created', 'delivered', 'postponed', 'cancelled', 'returned', '']) assert.equal(customerStageFor(status), '', status);
});

function makeService({ quietHours, clock }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'));
  const sent = [];
  const metaWrites = [];
  const service = new ConfirmationService({
    store: new JsonStore(path.join(dir, 'db.json')),
    wasenderClient: { sendMessage: async (payload) => { sent.push(payload); return { success: true, data: { msgId: 7 } }; } },
    wooClient: { updateOrderMeta: async (id, meta) => { metaWrites.push(meta); return { id, meta_data: meta }; }, addOrderNote: async () => ({}) },
    messages: {
      quietHours,
      shippedMessage: 'Shipped {{orderId}} {{trackingNumber}} {{deliveryEta}}',
      outForDeliveryMessage: 'Arriving {{orderId}}',
      deliveryEtaCasablanca: '24h',
      deliveryEtaOtherCities: '2 days'
    },
    logger: { log() {}, warn() {}, error() {} }
  });
  service.clock = clock;
  return { service, sent, metaWrites };
}

const WOO_ORDER = {
  id: 501,
  status: 'completed',
  total: '300',
  billing: { first_name: 'Test', last_name: 'Client', phone: '+212600000041', city: 'Rabat' },
  shipping: { city: 'Rabat' },
  line_items: [{ name: 'Cap', quantity: 1 }],
  meta_data: []
};

test('stage message is held in quiet hours, then sent once after', async () => {
  let now = at('2026-11-14T22:30:00Z'); // 23:30 in Morocco
  const { service, sent } = makeService({ quietHours: QUIET, clock: () => now });

  const night = await service.sendHdStageMessage(WOO_ORDER, 'shipped', 'NAI000777', now);
  assert.deepEqual(night, { sent: false, reason: 'quiet_hours' });
  assert.equal(sent.length, 0, 'nothing sent at night');

  now = at('2026-11-15T09:30:00Z'); // 10:30 in Morocco
  const morning = await service.sendHdStageMessage(WOO_ORDER, 'shipped', 'NAI000777', now);
  assert.equal(morning.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /NAI000777/u);
  assert.match(sent[0].message, /2 days/u);

  const again = await service.sendHdStageMessage({ ...WOO_ORDER, meta_data: [{ key: 'rhymat_whatsapp_hd_shipped_state', value: 'sent' }] }, 'shipped', 'NAI000777', now);
  assert.deepEqual(again, { sent: false, reason: 'already_sent' });
  assert.equal(sent.length, 1, 'never twice');
});

test('stage message skips an opted-out customer and an order without phone', async () => {
  const now = at('2026-11-15T09:30:00Z');
  const { service, sent } = makeService({ quietHours: QUIET, clock: () => now });
  service.store.upsertContact({ phone: '+212600000041', marketingStatus: 'opted_out' }); // the REAL store method, not a mock
  assert.equal((await service.sendHdStageMessage(WOO_ORDER, 'arriving', 'T', now)).reason, 'opted_out');
  service.store.upsertContact({ phone: '+212600000041', marketingStatus: 'subscribed' });
  assert.equal((await service.sendHdStageMessage({ ...WOO_ORDER, billing: {}, shipping: {} }, 'arriving', 'T', now)).reason, 'no_template_or_phone');
  assert.equal(sent.length, 0);
});

function makeSync({ orders, parcels, outcome = { sent: true } }) {
  const calls = { meta: [], notes: [], status: [], stage: [] };
  const wooClient = {
    getOrder: async (id) => orders.find((o) => String(o.id) === String(id)),
    updateOrderMeta: async (id, meta) => { calls.meta.push({ id, meta }); return { ...orders.find((o) => String(o.id) === String(id)), meta_data: meta }; },
    addOrderNote: async (id, note) => { calls.notes.push({ id, note }); },
    updateOrderStatus: async (id, status) => { calls.status.push({ id, status }); }
  };
  const confirmationService = {
    listOrdersForStatuses: async () => orders,
    withOrderLock: async (_id, work) => work(),
    sendHdStageMessage: async (order, stage, tracking) => { calls.stage.push({ id: order.id, stage, tracking }); return outcome; }
  };
  const sync = new HdStatusSyncService({
    confirmationService,
    wooClient,
    hdClient: { isConfigured: () => true, listPackages: async () => parcels },
    logger: { log() {}, warn() {}, error() {} }
  });
  return { sync, calls };
}

const NOW = at('2026-11-15T11:00:00Z');
const sentRecently = new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString();
const trackedOrder = (id, tracking, extra = []) => ({
  id,
  status: 'completed',
  meta_data: [{ key: HD_META.tracking, value: tracking }, { key: HD_META.sentAt, value: sentRecently }, ...extra]
});

test('sync: a status change is stored, noted, and the stage message is tried', async () => {
  const { sync, calls } = makeSync({
    orders: [trackedOrder(1, 'NAI000001')],
    parcels: [{ tracking_number: 'NAI000001', status: 'picked_up' }]
  });
  const summary = await sync.run({ now: NOW });
  assert.equal(summary.changed, 1);
  assert.equal(summary.messagesSent, 1);
  assert.deepEqual(calls.stage, [{ id: 1, stage: 'shipped', tracking: 'NAI000001' }]);
  assert.equal(calls.meta[0].meta.find((m) => m.key === HD_STATUS_META.status).value, 'picked_up');
  assert.match(calls.notes[0].note, /unknown -> picked_up/u);
  assert.equal(calls.status.length, 0, 'picked_up leaves the Woo status alone');
});

test('sync: delivered completes an on-hold order; returned cancels a completed one; final statuses are not re-checked', async () => {
  const { sync, calls } = makeSync({
    orders: [
      { ...trackedOrder(2, 'NAI000002'), status: 'on-hold' },
      trackedOrder(3, 'NAI000003'),
      trackedOrder(4, 'NAI000004', [{ key: HD_STATUS_META.status, value: 'delivered' }])
    ],
    parcels: [
      { tracking_number: 'NAI000002', status: 'delivered' },
      { tracking_number: 'NAI000003', status: 'returned' },
      { tracking_number: 'NAI000004', status: 'returned' }
    ]
  });
  const summary = await sync.run({ now: NOW });
  assert.deepEqual(calls.status, [{ id: '2', status: 'completed' }, { id: '3', status: 'cancelled' }]);
  assert.equal(summary.checked, 2, 'order 4 was already final');
  assert.equal(calls.stage.length, 0, 'no customer message for end states');
});

test('sync: a message held by quiet hours is retried on the next run even if the status did not change', async () => {
  const order = trackedOrder(5, 'NAI000005', [{ key: HD_STATUS_META.status, value: 'out_for_delivery' }]);
  const { sync, calls } = makeSync({
    orders: [order],
    parcels: [{ tracking_number: 'NAI000005', status: 'out_for_delivery' }],
    outcome: { sent: false, reason: 'quiet_hours' }
  });
  const summary = await sync.run({ now: NOW });
  assert.equal(summary.changed, 0);
  assert.equal(summary.messagesDeferred, 1);
  assert.deepEqual(calls.stage, [{ id: 5, stage: 'arriving', tracking: 'NAI000005' }]);
});

test('sync: no customer message for an old parcel or a cancelled order', async () => {
  const old = { ...trackedOrder(6, 'NAI000006'), meta_data: [{ key: HD_META.tracking, value: 'NAI000006' }, { key: HD_META.sentAt, value: '2026-10-01T00:00:00Z' }] };
  const cancelled = { ...trackedOrder(7, 'NAI000007'), status: 'on-hold' };
  const { sync, calls } = makeSync({
    orders: [old, cancelled],
    parcels: [{ tracking_number: 'NAI000006', status: 'in_transit' }, { tracking_number: 'NAI000007', status: 'cancelled' }]
  });
  await sync.run({ now: NOW });
  assert.equal(calls.stage.length, 0);
  assert.deepEqual(calls.status, [{ id: '7', status: 'cancelled' }]);
});

test('sync: disabled or unconfigured does nothing, and a platform outage never throws', async () => {
  const off = new HdStatusSyncService({ confirmationService: {}, wooClient: {}, hdClient: { isConfigured: () => true }, enabled: false, logger: console });
  assert.equal((await off.run()).disabled, true);
  const down = new HdStatusSyncService({
    confirmationService: { listOrdersForStatuses: async () => [] },
    wooClient: {},
    hdClient: { isConfigured: () => true, listPackages: async () => { throw new Error('boom'); } },
    logger: { log() {}, warn() {}, error() {} }
  });
  assert.equal((await down.run()).errors, 1);
});

test('new Woo statuses: delivered/confirmed are written only when configured, and both old and new are read', async () => {
  const { wooStatusMatchesTarget, isConfirmedWooStatus } = await import('../src/utils/hd-status.js');
  const NEW = { confirmed: 'confirmed', delivered: 'delivered' };
  assert.equal(wooStatusChange('delivered', 'completed', NEW), 'delivered', 'sent-to-HighDelivery orders become delivered');
  assert.equal(wooStatusChange('delivered', 'confirmed', NEW), 'delivered');
  assert.equal(wooStatusChange('delivered', 'delivered', NEW), null);
  assert.equal(wooStatusChange('returned', 'delivered', NEW), null, 'a delivered order is closed');
  assert.equal(wooStatusChange('returned', 'completed', NEW), 'cancelled');
  assert.equal(wooStatusChange('delivered', 'completed'), null, 'defaults keep the old behaviour: completed stays completed');
  assert.equal(wooStatusChange('delivered', 'on-hold'), 'completed');
  assert.equal(isConfirmedWooStatus('on-hold'), true);
  assert.equal(isConfirmedWooStatus('confirmed'), true);
  assert.equal(isConfirmedWooStatus('processing'), false);
  assert.equal(wooStatusMatchesTarget('on-hold', 'confirmed'), true, 'an old on-hold order is not a mismatch');
  assert.equal(wooStatusMatchesTarget('confirmed', 'on-hold'), true);
  assert.equal(wooStatusMatchesTarget('processing', 'confirmed'), false);
  assert.equal(wooStatusMatchesTarget('cancelled', 'cancelled'), true);
});

test('auto-send accepts a confirmed order as well as an on-hold one', async () => {
  const { HdAutoSendService } = await import('../src/services/hd-auto-send-service.js');
  for (const status of ['on-hold', 'confirmed']) {
    let created = 0;
    const service = new HdAutoSendService({
      claimSettleMs: 0, // no 1 s wait after the reservation in tests (services/claim.js)
      hdClient: { isConfigured: () => true, trustScore: async () => ({ score: 80 }), createPackage: async () => { created += 1; return { trackingNumber: 'NAI000321' }; } },
      wooClient: {
        getOrder: async () => ({
          id: 321, status, total: '300', currency: 'MAD', meta_data: [],
          billing: { first_name: 'A', last_name: 'B', phone: '0612345678', city: 'Rabat', address_1: 'Rue 1' },
          shipping: { first_name: 'A', last_name: 'B', phone: '0612345678', city: 'Rabat', address_1: 'Rue 1' },
          line_items: [{ name: 'Cap', quantity: 1 }]
        }),
        updateOrderMeta: async () => ({}), addOrderNote: async () => ({}), updateOrderStatus: async () => ({})
      },
      wasenderClient: { sendMessage: async () => ({}) },
      store: {},
      notifyPhones: [],
      enabled: true,
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal((await service.autoSend({ orderId: '321' })).status, 'sent', status);
    assert.equal(created, 1, status);
  }
});


// ---- fixes from the independent review ----------------------------------------------------------------------------

test('review #3: a failed Woo status write is retried even though the HighDelivery status was already final', async () => {
  const order = { ...trackedOrder(11, 'NAI000011', [{ key: HD_STATUS_META.status, value: 'delivered' }]), status: 'completed' };
  const calls = { status: [] };
  const sync = new HdStatusSyncService({
    confirmationService: { listOrdersForStatuses: async () => [order], withOrderLock: async (_id, work) => work(), sendHdStageMessage: async () => ({ sent: false }) },
    wooClient: { getOrder: async () => order, updateOrderMeta: async () => order, addOrderNote: async () => ({}), updateOrderStatus: async (id, status) => { calls.status.push({ id, status }); } },
    hdClient: { isConfigured: () => true, listPackages: async () => [] },
    wooStatuses: { confirmed: 'confirmed', delivered: 'delivered' },
    logger: { log() {}, warn() {}, error() {} }
  });
  await sync.run({ now: NOW });
  assert.deepEqual(calls.status, [{ id: '11', status: 'delivered' }], 'the order catches up to delivered');
});

test('review #3: when the Woo status write fails, the saved status is not advanced, so the next run tries again', async () => {
  const order = trackedOrder(12, 'NAI000012');
  const writes = [];
  const sync = new HdStatusSyncService({
    confirmationService: { listOrdersForStatuses: async () => [order], withOrderLock: async (_id, work) => work(), sendHdStageMessage: async () => ({ sent: false }) },
    wooClient: { getOrder: async () => order, updateOrderMeta: async (id, meta) => { writes.push(meta); return order; }, addOrderNote: async () => ({}), updateOrderStatus: async () => { throw new Error('woo 503'); } },
    hdClient: { isConfigured: () => true, listPackages: async () => [{ tracking_number: 'NAI000012', status: 'delivered' }] },
    wooStatuses: { confirmed: 'confirmed', delivered: 'delivered' },
    logger: { log() {}, warn() {}, error() {} }
  });
  const summary = await sync.run({ now: NOW });
  assert.equal(summary.errors, 1);
  assert.equal(writes.length, 0, 'the HighDelivery status is only saved after the Woo status was written');
});

test('review #6: parcels older than 30 days are left alone', async () => {
  const old = { ...trackedOrder(13, 'NAI000013'), meta_data: [{ key: HD_META.tracking, value: 'NAI000013' }, { key: HD_META.sentAt, value: '2026-09-01T00:00:00Z' }] };
  const { sync, calls } = makeSync({ orders: [old], parcels: [{ tracking_number: 'NAI000013', status: 'delivered' }] });
  const summary = await sync.run({ now: NOW });
  assert.equal(summary.checked, 0);
  assert.equal(calls.status.length, 0);
  assert.equal(calls.notes.length, 0);
});

test('review #1/#4: only a reply held back by the quiet hours is sent later (auto-cancelled orders are never messaged)', async () => {
  const now = at('2026-11-15T09:30:00Z');
  const { service, sent } = makeService({ quietHours: QUIET, clock: () => now });
  service.messages.cancelledReply = 'Cancelled reply';
  service.messages.confirmedReply = 'Confirmed reply';
  const base = (extra = []) => ({ ...WOO_ORDER, status: 'cancelled', meta_data: extra });
  const normalized = { orderId: '501', phone: '+212600000041', customerReplySent: 'no' };
  const decisionMeta = { decisionAt: '2026-11-15T06:00:00Z', customerReplySent: 'no', invalidReplyCount: 0 };

  // Auto-cancelled (no 'deferred' mark): nothing is sent.
  assert.equal(await service.sendDeferredDecisionReply({ order: base(), nextOrderState: normalized, decisionMeta, effectiveDecision: 'cancelled', now }), false);
  assert.equal(sent.length, 0);

  // Held back at night (reservation state 'deferred'): sent now.
  const held = base([{ key: 'rhymat_whatsapp_cancellation_success_state', value: 'deferred' }]);
  await service.sendDeferredDecisionReply({ order: held, nextOrderState: normalized, decisionMeta, effectiveDecision: 'cancelled', now });
  assert.deepEqual(sent.map((row) => row.message), ['Cancelled reply']);
});

test('review #2: a status the shop does not know is skipped, not fatal', async () => {
  const { WooCommerceClient } = await import('../src/services/woocommerce-client.js');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const status = new URL(url).searchParams.get('status');
    if (status === 'confirmed') {
      return { ok: false, status: 400, headers: new Map(), text: async () => JSON.stringify({ code: 'rest_invalid_param', message: 'Invalid parameter(s): status' }) };
    }
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(status === 'on-hold' ? [{ id: 7 }] : []) };
  };
  const client = new WooCommerceClient({ baseUrl: 'https://shop.example', consumerKey: 'k', consumerSecret: 's', fetchImpl, logger: { log() {}, warn() {}, error() {} } });
  const orders = await client.listOrdersByStatuses(['confirmed', 'on-hold']);
  assert.deepEqual(orders.map((o) => o.id), [7]);
});

test('review #5: the hourly task never runs twice at once', async () => {
  const http = await import('node:http');
  const { createApp } = await import('../src/app.js');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const app = createApp({
    config: { tasks: { secret: 's3cret' } },
    confirmationService: { runOrderFollowups: async () => { runs += 1; await gate; return {}; } },
    store: {},
    logger: { log() {}, warn() {}, error() {} }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}/tasks/order-followups`;
  try {
    const first = fetch(url, { method: 'POST', headers: { 'x-task-secret': 's3cret' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await fetch(url, { method: 'POST', headers: { 'x-task-secret': 's3cret' } });
    assert.equal(second.status, 202);
    assert.equal((await second.json()).skipped, 'already_running');
    release();
    assert.equal((await first).status, 200);
    assert.equal(runs, 1);
  } finally {
    release();
    server.close();
  }
});

test('review #7: stock alerts wait for the end of the quiet hours', async () => {
  const { StockAlertService } = await import('../src/services/stock-alert-service.js');
  let quiet = true;
  const sent = [];
  const db = { stockAlerts: [{ id: 'a1', status: 'queued', phone: '+212600000041', productName: 'Cap', size: 'M', productUrl: 'https://x' }] };
  const store = { read: () => db, transaction: (fn) => fn(db), appendMessage() {} };
  const service = new StockAlertService({ store, wasenderClient: { sendMessage: async (p) => { sent.push(p); return {}; } }, logger: { log() {}, warn() {}, error() {} }, autoProcess: false, isQuiet: () => quiet });
  await service.runQueue();
  assert.equal(sent.length, 0);
  assert.equal(db.stockAlerts[0].status, 'queued');
  quiet = false;
  await service.runQueue();
  assert.equal(sent.length, 1);
  assert.equal(db.stockAlerts[0].status, 'sent');
});

test('review #9: the parcel list is read page by page even without a total', async () => {
  const { HighDeliveryClient } = await import('../src/services/highdelivery-client.js');
  const pages = [Array.from({ length: 100 }, (_, i) => ({ tracking_number: `A${i}` })), [{ tracking_number: 'B1' }]];
  let call = 0;
  const fetchImpl = async (url) => {
    const body = String(url).endsWith('/auth/login') ? { success: true, data: { token: 't' } } : { success: true, data: { packages: pages[call++] || [] } };
    return { status: 200, json: async () => body };
  };
  const client = new HighDeliveryClient({ phone: '0611111111', password: 'pw', fetchImpl, logger: { log() {}, warn() {}, error() {} } });
  assert.equal((await client.listPackages()).length, 101);
});

test('review #11: a mistyped time zone falls back to Morocco instead of breaking every send', () => {
  assert.equal(parseQuietHoursEnv({ QUIET_HOURS_TIMEZONE: 'Mars/Phobos' }).timeZone, 'Africa/Casablanca');
  assert.equal(isQuietHours(at('2026-11-14T23:30:00Z'), { ...QUIET, timeZone: 'Mars/Phobos' }), true);
});

test('review #13: customer-typed text cannot add lines to a team alert', async () => {
  const { HdAutoSendService } = await import('../src/services/hd-auto-send-service.js');
  const sent = [];
  const service = new HdAutoSendService({ hdClient: {}, wooClient: {}, wasenderClient: { sendMessage: async (p) => { sent.push(p); return {}; } }, store: {}, notifyPhones: ['+212611111111'], logger: { log() {}, warn() {}, error() {} } });
  await service.sendInternal('9', { billing: { first_name: 'Eve\nATTENTION: fake line', phone: '0612345678' } }, 'N {{customerName}}', {}, 'x');
  assert.equal(sent[0].message.includes('\n'), false);
});

test('review #10: a number that is not on WhatsApp is marked failed and not retried', async () => {
  const { WasenderSendError } = await import('../src/services/wasender-client.js');
  const now = at('2026-11-15T09:30:00Z');
  const { service, metaWrites } = makeService({ quietHours: QUIET, clock: () => now });
  service.wasenderClient.sendMessage = async () => { throw new WasenderSendError({ status: 422, data: { message: 'not on whatsapp' }, message: 'x' }); };
  const first = await service.sendHdStageMessage(WOO_ORDER, 'shipped', 'T', now);
  assert.equal(first.reason, 'unreachable');
  assert.ok(JSON.stringify(metaWrites).includes('hd_shipped_state') && JSON.stringify(metaWrites).includes('failed'));
  const again = await service.sendHdStageMessage({ ...WOO_ORDER, meta_data: [{ key: 'rhymat_whatsapp_hd_shipped_state', value: 'failed' }] }, 'shipped', 'T', now);
  assert.equal(again.reason, 'unreachable');
});

test('review cost: the hourly task reads open orders in full and only recent closed orders', async () => {
  const now = at('2026-11-15T12:00:00Z');
  const { service } = makeService({ quietHours: QUIET, clock: () => now });
  const calls = [];
  service.wooClient.listOrdersByStatuses = async (statuses, options = {}) => { calls.push({ statuses, after: options.after || '' }); return []; };
  await service.runOrderFollowups({ now });
  const open = calls.find((call) => !call.after);
  const closed = calls.find((call) => call.after);
  assert.ok(open.statuses.includes('processing') && open.statuses.includes('on-hold') && open.statuses.includes('confirmed'));
  assert.ok(!open.statuses.includes('completed') && !open.statuses.includes('cancelled'));
  assert.deepEqual(closed.statuses, ['cancelled', 'completed', 'delivered', 'refunded']);
  assert.equal(closed.after, '2026-10-01T12:00:00.000Z', '45 days back');
});


// ---- fixes from the data-protection review -------------------------------------------------------------------------

test('review: logs never carry a full phone number', async () => {
  const { maskPhone, redactPhones } = await import('../src/utils/format.js');
  assert.equal(maskPhone('+212600000041'), '+212***41');
  assert.equal(maskPhone(''), '');
  assert.equal(redactPhones('{"jid":"+212600000041","msgId":7}'), '{"jid":"+212***41","msgId":7}');
  assert.equal(redactPhones('no numbers here 12345'), 'no numbers here 12345');
});

test('review: a WaSender request with no answer is ambiguous, and the reservation is kept', async () => {
  const { WasenderClient, WasenderSendError } = await import('../src/services/wasender-client.js');
  const logs = [];
  const client = new WasenderClient({
    baseUrl: 'https://wasender.example/api', apiToken: 't', minIntervalMs: 0, timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))); }),
    logger: { log() {}, warn: (m) => logs.push(m), error() {} }
  });
  await assert.rejects(client.sendMessage({ to: '+212600000041', message: 'x' }), (error) => error instanceof WasenderSendError && error.ambiguous === true);
  assert.ok(logs.some((line) => line.includes('no answer')) && !logs.join(' ').includes('+212600000041'), 'the number is masked in the log');

  // the confirmation flow must not release the reservation after an ambiguous failure (it may have been sent)
  const now = at('2026-11-15T09:30:00Z');
  const { service, metaWrites } = makeService({ quietHours: QUIET, clock: () => now });
  service.wasenderClient.sendMessage = async () => { throw new WasenderSendError({ status: 0, data: {}, message: 'timeout', ambiguous: true }); };
  const outcome = await service.sendLogicalMessageWithWooReservation({
    orderPayload: WOO_ORDER, orderId: '501', phone: '+212600000041', logicalKey: 'customer:hd_shipped', kind: 'hd_shipped', message: 'x', now
  });
  assert.equal(outcome.ambiguous, true);
  const cleared = metaWrites.flat().some((row) => String(row.key).endsWith('hd_shipped_state') && row.value === '');
  assert.equal(cleared, false, 'the reservation is not cleared after an ambiguous failure');
});
