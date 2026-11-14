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
  assert.deepEqual(parseQuietHoursEnv({}), QUIET);
  assert.deepEqual(parseQuietHoursEnv({ QUIET_HOURS_START: '23', QUIET_HOURS_END: '9', QUIET_HOURS_TIMEZONE: 'UTC' }), {
    enabled: true, startHour: 23, endHour: 9, timeZone: 'UTC'
  });
  assert.equal(parseQuietHoursEnv({ QUIET_HOURS_ENABLED: 'no' }).enabled, false);
  assert.equal(parseQuietHoursEnv({ QUIET_HOURS_START: 'abc' }).startHour, 22);
});

test('HighDelivery status to Woo status: only end states, only forward', () => {
  assert.equal(wooStatusChange('delivered', 'on-hold'), 'completed');
  assert.equal(wooStatusChange('delivered', 'processing'), 'completed');
  assert.equal(wooStatusChange('delivered', 'completed'), null);
  assert.equal(wooStatusChange('delivered', 'cancelled'), null, 'never reopen a cancelled order');
  assert.equal(wooStatusChange('returned', 'completed'), 'cancelled', 'a parcel that came back cancels the order');
  assert.equal(wooStatusChange('refused', 'on-hold'), 'cancelled');
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
  service.store.isOptedOut = () => true;
  assert.equal((await service.sendHdStageMessage(WOO_ORDER, 'arriving', 'T', now)).reason, 'opted_out');
  service.store.isOptedOut = () => false;
  assert.equal((await service.sendHdStageMessage({ ...WOO_ORDER, billing: {}, shipping: {} }, 'arriving', 'T', now)).reason, 'no_template_or_phone');
  assert.equal(sent.length, 0);
});

function makeSync({ orders, parcels, outcome = { sent: true } }) {
  const calls = { meta: [], notes: [], status: [], stage: [] };
  const wooClient = {
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
