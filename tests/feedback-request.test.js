import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { FeedbackRequestService } from '../src/services/feedback-request-service.js';
import { HD_STATUS_META } from '../src/domain/order-meta.js';

const QUIET = { enabled: true, startHour: 23, endHour: 9, weekendEndHour: 10, timeZone: 'Africa/Casablanca' };
const CONFIG = { enabled: true, delayDays: 3, from: '2026-11-19T00:00:00Z', maxAgeDays: 14, maxPerRun: 30 };
const QUIET_OFF = { ...QUIET, enabled: false };

function order(id, { status = 'delivered', deliveredAt = '2026-11-19T12:00:00Z', extra = [] } = {}) {
  return {
    id,
    status: 'delivered',
    total: '139',
    billing: { first_name: 'Test', last_name: 'Client', phone: '+212600000042', city: 'Rabat' },
    shipping: { city: 'Rabat' },
    line_items: [{ name: 'Cap', quantity: 1 }],
    meta_data: [
      { key: HD_STATUS_META.status, value: status },
      { key: HD_STATUS_META.statusAt, value: deliveredAt },
      ...extra
    ]
  };
}

function makeSetup(orders, { quietHours = QUIET_OFF, config = CONFIG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-request-'));
  const sent = [];
  const writes = [];
  const wooClient = {
    listOrdersByStatuses: async () => orders,
    getOrder: async (id) => orders.find((item) => String(item.id) === String(id)),
    updateOrderMeta: async (id, meta) => {
      writes.push({ id, meta });
      const target = orders.find((item) => String(item.id) === String(id));
      for (const row of meta) {
        const existing = target.meta_data.find((item) => item.key === row.key);
        if (existing) existing.value = row.value; else target.meta_data.push({ key: row.key, value: row.value });
      }
      return target;
    },
    addOrderNote: async () => ({})
  };
  const service = new ConfirmationService({
    store: new JsonStore(path.join(dir, 'db.json')),
    wasenderClient: { sendMessage: async (payload) => { await payload.beforeDispatch?.(); sent.push(payload); return { success: true, data: { msgId: 9 } }; } },
    wooClient,
    messages: { quietHours, feedbackRequestMessage: 'Hi {{customerName}} ref {{feedbackToken}}' },
    logger: { log() {}, warn() {}, error() {} }
  });
  const feedback = new FeedbackRequestService({ confirmationService: service, wooClient, config, logger: { log() {}, warn() {}, error() {} } });
  return { feedback, sent, writes, orders, service };
}

const NOW = new Date('2026-11-23T12:00:00Z'); // Monday, 13:00 in the shop

test('feedback request: due only 3+ days after delivery, from the start date, never twice, never old', () => {
  const { feedback } = makeSetup([]);
  assert.equal(feedback.isDue(order(1, { deliveredAt: '2026-11-19T12:00:00Z' }), NOW), true, '4 days after');
  assert.equal(feedback.isDue(order(1, { deliveredAt: '2026-11-20T12:30:00Z' }), NOW), false, 'only 2.9 days after');
  assert.equal(feedback.isDue(order(1, { deliveredAt: '2026-11-18T19:00:00Z' }), NOW), false, 'delivered before the start date');
  assert.equal(feedback.isDue(order(1, { deliveredAt: '2026-11-19T12:00:00Z' }), new Date('2026-12-10T12:00:00Z')), false, 'older than 14 days');
  assert.equal(feedback.isDue(order(1, { status: 'in_transit' }), NOW), false, 'not delivered');
  assert.equal(feedback.isDue(order(1, { extra: [{ key: 'rhymat_feedback_requested_at', value: '2026-11-22T10:00:00Z' }] }), NOW), false, 'already asked (desktop)');
  assert.equal(feedback.isDue(order(1, { extra: [{ key: 'rhymat_feedback_state', value: 'waiting_for_feedback' }] }), NOW), false, 'already waiting');
});

test('feedback request: sent once with the token, and the order is marked so a reply can be matched', async () => {
  const orders = [order(501), order(502, { deliveredAt: '2026-11-22T12:00:00Z' })];
  const { feedback, sent, orders: live } = makeSetup(orders);
  const first = await feedback.run({ now: NOW });
  assert.equal(first.sent, 1, 'the 1-day-old delivery is not due yet');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /FDBK-501/u);
  const meta = Object.fromEntries(live[0].meta_data.map((row) => [row.key, row.value]));
  assert.equal(meta.rhymat_feedback_token, 'FDBK-501');
  assert.equal(meta.rhymat_feedback_state, 'waiting_for_feedback');
  assert.ok(meta.rhymat_feedback_sent_at && meta.rhymat_feedback_requested_at);
  assert.equal(meta.rhymat_whatsapp_feedback_request_state, 'sent');

  const second = await feedback.run({ now: NOW });
  assert.equal(second.sent, 0, 'never twice');
  assert.equal(sent.length, 1);
});

test('feedback request: nothing goes out in quiet hours; it goes the next morning', async () => {
  const night = new Date('2026-11-23T22:30:00Z'); // 23:30 in the shop
  const { feedback, sent, service } = makeSetup([order(503)], { quietHours: QUIET });
  service.clock = () => night;
  const held = await feedback.run({ now: night });
  assert.equal(held.sent, 0);
  assert.equal(held.deferred, 1);
  assert.equal(sent.length, 0);
  const next = new Date('2026-11-24T09:30:00Z'); // 10:30 in the shop
  service.clock = () => next;
  const morning = await feedback.run({ now: next });
  assert.equal(morning.sent, 1);
});

test('feedback request: off when disabled, and an opted-out customer is skipped', async () => {
  const off = makeSetup([order(504)], { config: { ...CONFIG, enabled: false } });
  assert.equal((await off.feedback.run({ now: NOW })).disabled, true);
  assert.equal(off.sent.length, 0);
  const optOut = makeSetup([order(505)]);
  optOut.feedback.confirmationService.store.upsertContact({ phone: '+212600000042', marketingStatus: 'opted_out' });
  assert.equal((await optOut.feedback.run({ now: NOW })).sent, 0);
  assert.equal(optOut.sent.length, 0);
});
