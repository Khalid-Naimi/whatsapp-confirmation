import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';

const quiet = { log() {}, warn() {}, error() {} };
const HOUR = 60 * 60 * 1000;

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
  defaultCityLabel: 'Maghrib'
};

function meta(values) {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function baseOrder(id, extra = {}) {
  return {
    id,
    status: 'processing',
    date_created_gmt: new Date(Date.now() - HOUR).toISOString().slice(0, 19),
    billing: { first_name: 'Test', phone: `+2126000${String(id).padStart(5, '0')}`, state: 'Casablanca', address_1: 'Rue 1' },
    line_items: [{ name: 'Tee', quantity: 1 }],
    total: '100',
    meta_data: [],
    ...extra
  };
}

// WooCommerce as the service sees it: `orders` is the live data; `listed` (when set) is what the order list returns.
function makeContext({ orders = [], listed = null, notify = false, hdAutoSend = null, confirmationDelayMs = 0 } = {}) {
  const live = new Map(orders.map((order) => [String(order.id), structuredClone(order)]));
  const sends = [];
  const notes = [];
  const teamAlerts = [];
  const metaWrites = [];
  const woo = {
    listFailures: 0,
    async listOrdersByStatuses(statuses) {
      if (woo.listFailures > 0) {
        woo.listFailures -= 1;
        throw new Error('WooCommerce request failed with 503: {"code":"busy"}');
      }
      const source = listed ? listed.map((order) => structuredClone(order)) : [...live.values()].map((order) => structuredClone(order));
      return source.filter((order) => statuses.includes(order.status));
    },
    async listOrders() { return []; },
    async getOrder(id) {
      const order = live.get(String(id));
      if (!order) {
        throw new Error('not found');
      }
      return structuredClone(order);
    },
    async updateOrder(id, fields) {
      const order = live.get(String(id)) || { id, meta_data: [] };
      if (fields.status) {
        order.status = fields.status;
      }
      for (const row of fields.meta_data || []) {
        metaWrites.push({ id: String(id), key: row.key, value: row.value });
        const at = order.meta_data.findIndex((item) => item.key === row.key);
        if (at >= 0) {
          order.meta_data[at] = { ...order.meta_data[at], ...row };
        } else {
          order.meta_data.push({ ...row });
        }
      }
      live.set(String(id), order);
      return structuredClone(order);
    },
    async updateOrderMeta(id, rows) { return woo.updateOrder(id, { meta_data: rows }); },
    async updateOrderStatus(id, status) { return woo.updateOrder(id, { status }); },
    async addOrderNote(id, note) { notes.push({ id: String(id), note }); return {}; },
    // Only the order notes route is used through the generic request.
    async request(urlPath, { method }) {
      const match = urlPath.match(/\/orders\/(\d+)\/notes$/u);
      if (method !== 'GET' || !match) {
        throw new Error(`unexpected request ${urlPath}`);
      }
      return notes.filter((item) => item.id === match[1]).map((item) => ({ note: item.note }));
    }
  };
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dup-wa-')), 'db.json'), { logger: quiet });
  const service = new ConfirmationService({
    store,
    wasenderClient: { async sendMessage(payload) { sends.push(payload); return { id: `m${sends.length}` }; }, async sendPoll() { return {}; } },
    wooClient: woo,
    messages: { ...messages, confirmationDelayMs },
    notifyTeam: notify ? async (message) => { teamAlerts.push(message); return 1; } : null,
    hdAutoSend,
    sleep: async () => {},
    logger: quiet
  });
  const metaOf = (id, key) => live.get(String(id))?.meta_data.find((row) => row.key === key)?.value;
  return { service, store, woo, live, sends, notes, teamAlerts, metaWrites, metaOf };
}

test('hourly: a reminder decided on the old list is not sent when the order changed meanwhile', async () => {
  const sentAt = new Date(Date.now() - 25 * HOUR).toISOString();
  const listedOrder = baseOrder(11, { meta_data: meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: sentAt, rhymat_whatsapp_reminder_count: 0, rhymat_whatsapp_confirmation_request_state: 'sent' }) });
  // Live order: the reminder already went out (an overlapping run), or the customer already answered.
  const liveOrder = structuredClone(listedOrder);
  liveOrder.meta_data.push(...meta({ rhymat_whatsapp_reminder_1_state: 'sent' }));
  liveOrder.meta_data.find((row) => row.key === 'rhymat_whatsapp_reminder_count').value = 1;
  const { service, sends } = makeContext({ orders: [liveOrder], listed: [listedOrder] });
  const summary = await service.runOrderFollowups();
  assert.equal(sends.length, 0);
  assert.equal(summary.remindersSent, 0);
});

test('hourly: an unchanged order still gets its reminder (the re-read does not block normal work)', async () => {
  const sentAt = new Date(Date.now() - 25 * HOUR).toISOString();
  const order = baseOrder(12, { meta_data: meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: sentAt, rhymat_whatsapp_reminder_count: 0, rhymat_whatsapp_confirmation_request_state: 'sent' }) });
  const { service, sends } = makeContext({ orders: [order] });
  const summary = await service.runOrderFollowups();
  assert.equal(summary.remindersSent, 1);
  assert.equal(sends.length, 1);
});

// The WooCommerce client retries GETs itself (no answer, 429, 5xx); the hourly run no longer adds a second layer of
// retries on top, so an error that is still there after the client's retries fails this hour (the next hour runs).
test('hourly: an order list error left after the client retries fails the hour, without a second retry layer', async () => {
  const sentAt = new Date(Date.now() - 25 * HOUR).toISOString();
  const order = baseOrder(13, { meta_data: meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: sentAt, rhymat_whatsapp_reminder_count: 0 }) });
  const { service, woo, sends } = makeContext({ orders: [order] });
  woo.listFailures = 1;
  await assert.rejects(service.runOrderFollowups(), /503/u);
  assert.equal(woo.listFailures, 0);
  assert.equal(sends.length, 0);
  const summary = await service.runOrderFollowups();
  assert.equal(summary.remindersSent, 1);
});

test('the first confirmation is never sent by both the 30-second timer and the hourly backfill', async () => {
  const order = baseOrder(21);
  const { service, sends } = makeContext({ orders: [order], confirmationDelayMs: 60 * 60 * 1000 });
  const scheduled = await service.processWooOrder(structuredClone(order), 'delivery-21');
  assert.equal(scheduled.body.scheduled, true);
  try {
    const summary = await service.runOrderFollowups();
    assert.equal(summary.backfilled, 0);
    assert.equal(sends.length, 0);
    // The timer fires: exactly one message.
    await service.runDelayedInitialConfirmation(structuredClone(order), '21');
    assert.equal(sends.length, 1);
  } finally {
    clearTimeout(service.pendingInitialConfirmations.get('21'));
    service.pendingInitialConfirmations.clear();
  }
});

test('the hourly backfill does not resend a first confirmation that went out after the list was read', async () => {
  const listedOrder = baseOrder(22);
  const liveOrder = structuredClone(listedOrder);
  liveOrder.meta_data.push(...meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: new Date().toISOString(), rhymat_whatsapp_confirmation_request_state: 'sent' }));
  const { service, sends } = makeContext({ orders: [liveOrder], listed: [listedOrder] });
  const summary = await service.runOrderFollowups();
  assert.equal(summary.backfilled, 0);
  assert.equal(sends.length, 0);
});

test('a send reserved more than 2 hours ago is closed as sent, the team is told once, and the follow-ups go on', async () => {
  const reservedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const order = baseOrder(31, { meta_data: meta({ rhymat_whatsapp_confirmation_request_state: 'reserved', rhymat_whatsapp_confirmation_request_reserved_at: reservedAt }) });
  const { service, sends, teamAlerts, metaOf, notes } = makeContext({ orders: [order], notify: true });
  const first = await service.runOrderFollowups();
  assert.equal(first.ambiguous, 1);
  assert.equal(sends.length, 0);
  assert.equal(teamAlerts.length, 1);
  assert.match(teamAlerts[0], /commande 31/u);
  assert.ok(!teamAlerts[0].includes('+212'));
  assert.equal(metaOf(31, 'rhymat_whatsapp_confirmation_request_state'), 'sent');
  assert.equal(metaOf(31, 'rhymat_whatsapp_confirmation_sent_at'), reservedAt);
  assert.equal(metaOf(31, 'rhymat_whatsapp_state'), 'pending');
  assert.equal(notes.length, 1);

  const second = await service.runOrderFollowups();
  assert.equal(second.ambiguous, 0);
  assert.equal(teamAlerts.length, 1);
  assert.equal(sends.length, 0);

  // 24 hours after the (assumed) first message, the reminder follows as usual.
  const later = await service.runOrderFollowups({ now: new Date(Date.parse(reservedAt) + 25 * HOUR) });
  assert.equal(later.remindersSent, 1);
  assert.equal(sends.length, 1);
});

test("the service's own status change after the customer's answer is not a manual override", async () => {
  const order = baseOrder(41, {
    status: 'on-hold',
    meta_data: meta({ rhymat_whatsapp_state: 'confirmed', rhymat_whatsapp_confirmation_sent_at: new Date().toISOString(), rhymat_whatsapp_decision: 'confirmed', rhymat_whatsapp_woo_sync_status: 'synced' })
  });
  const { service, metaWrites, notes } = makeContext({ orders: [order] });
  const result = await service.processWooOrder(structuredClone(order), 'update-41');
  assert.equal(result.body.reason, 'own_status_change');
  assert.equal(metaWrites.length, 0);
  assert.equal(notes.length, 0);
  // Completed by the HighDelivery auto-send: still the service's own path.
  const completed = { ...structuredClone(order), status: 'completed' };
  assert.equal((await service.processWooOrder(completed, 'update-41b')).body.reason, 'own_status_change');
});

test('a real manual change is recorded once: repeating it rewrites nothing and adds no second note', async () => {
  const order = baseOrder(42, { status: 'completed', meta_data: meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: new Date().toISOString() }) });
  const { service, metaWrites, notes, metaOf } = makeContext({ orders: [order] });
  const first = await service.processWooOrder(structuredClone(order), 'update-42');
  assert.equal(first.body.reason, 'manual_override');
  assert.equal(metaOf(42, 'rhymat_whatsapp_manual_override'), 'yes');
  const writesAfterFirst = metaWrites.length;
  assert.equal(notes.length, 1);

  await service.markManualOverride({ order: { orderId: '42', rawOrder: structuredClone(order) }, status: 'completed' });
  await service.runOrderFollowups();
  assert.equal(metaWrites.length, writesAfterFirst);
  assert.equal(notes.length, 1);
});

test('the same inbound message delivered twice at once is handled once', async () => {
  const order = baseOrder(51, { status: 'processing', meta_data: meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: new Date().toISOString(), rhymat_whatsapp_confirmation_request_state: 'sent' }) });
  const { service, sends } = makeContext({ orders: [order] });
  const payload = { data: { messages: { key: { id: 'WA-MSG-1', cleanedSenderPn: '212600000051', fromMe: false }, messageBody: 'hello?' } } };
  const [a, b] = await Promise.all([
    service.processWasenderInbound(structuredClone(payload), 'event-a'),
    service.processWasenderInbound(structuredClone(payload), 'event-b')
  ]);
  assert.equal(a.body.duplicates + b.body.duplicates, 1);
  // One "please answer 1 or 2", not two.
  assert.equal(sends.filter((send) => send.message === messages.invalidReply).length, 1);
});

test('after a restart, a reply already recorded on the order is not handled again', async () => {
  const order = baseOrder(52, {
    status: 'processing',
    meta_data: meta({ rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: new Date().toISOString(), rhymat_whatsapp_invalid_reply_count: 1, rhymat_whatsapp_last_confirmation_message_key: 'WA-MSG-2' })
  });
  const { service, store, sends } = makeContext({ orders: [order] });
  // The local cache (rebuilt after the restart) does not know the key yet.
  store.upsertOrder({ orderId: '52', phone: '+212600000052', confirmationState: 'pending_confirmation', rawOrder: { id: 52, meta_data: [] } });
  const payload = { data: { messages: { key: { id: 'WA-MSG-2', cleanedSenderPn: '212600000052', fromMe: false }, messageBody: 'hello?' } } };
  const result = await service.processWasenderInbound(payload, 'event-c');
  assert.equal(result.body.duplicates, 1);
  assert.equal(sends.length, 0);
});

test('a confirmed order whose first status write failed is sent to HighDelivery by the hourly run, once', async () => {
  const autoSends = [];
  const hdAutoSend = { enabled: true, async autoSend(order) { autoSends.push(order.orderId); return { status: 'sent' }; } };
  const order = baseOrder(61, {
    status: 'processing',
    meta_data: meta({
      rhymat_whatsapp_state: 'confirmed',
      rhymat_whatsapp_confirmation_sent_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      rhymat_whatsapp_decision: 'confirmed',
      rhymat_whatsapp_decision_at: new Date(Date.now() - HOUR).toISOString(),
      rhymat_whatsapp_woo_sync_status: 'pending_retry',
      rhymat_whatsapp_woo_sync_attempts: 1,
      rhymat_whatsapp_customer_reply_sent: 'yes'
    })
  });
  const { service, metaOf } = makeContext({ orders: [order], hdAutoSend });
  await service.runOrderFollowups();
  await service.drainBackgroundTasks();
  assert.deepEqual(autoSends, ['61']);
  assert.ok(metaOf(61, 'rhymat_hd_api_retry_at'));
  await service.runOrderFollowups();
  await service.drainBackgroundTasks();
  assert.deepEqual(autoSends, ['61']);
});

test('a confirmed order that the normal path already handed to HighDelivery is never retried', async () => {
  const autoSends = [];
  const hdAutoSend = { enabled: true, async autoSend(order) { autoSends.push(order.orderId); return { status: 'sent' }; } };
  const order = baseOrder(62, {
    status: 'on-hold',
    meta_data: meta({ rhymat_whatsapp_decision: 'confirmed', rhymat_whatsapp_decision_at: new Date().toISOString(), rhymat_whatsapp_woo_sync_status: 'synced', rhymat_whatsapp_woo_sync_attempts: 1 })
  });
  const { service } = makeContext({ orders: [order], hdAutoSend });
  await service.runOrderFollowups();
  await service.drainBackgroundTasks();
  assert.deepEqual(autoSends, []);
});

function retryCandidate(id, extraMeta = {}) {
  return baseOrder(id, {
    status: 'processing',
    meta_data: meta({
      rhymat_whatsapp_state: 'confirmed',
      rhymat_whatsapp_confirmation_sent_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      rhymat_whatsapp_decision: 'confirmed',
      rhymat_whatsapp_decision_at: new Date(Date.now() - HOUR).toISOString(),
      rhymat_whatsapp_woo_sync_status: 'pending_retry',
      rhymat_whatsapp_woo_sync_attempts: 1,
      rhymat_whatsapp_customer_reply_sent: 'yes',
      ...extraMeta
    })
  });
}

test('the one-time HighDelivery retry is skipped when a parcel trace or a HighDelivery note exists', async () => {
  const autoSends = [];
  const hdAutoSend = { enabled: true, async autoSend(order) { autoSends.push(order.orderId); return { status: 'sent' }; } };
  const traced = makeContext({ orders: [retryCandidate(63, { rhymat_hd_status: 'picked_up' })], hdAutoSend });
  await traced.service.runOrderFollowups();
  await traced.service.drainBackgroundTasks();

  const noted = makeContext({ orders: [retryCandidate(64)], hdAutoSend });
  await noted.woo.addOrderNote(64, 'Auto-send to HighDelivery held for review: low trust score.');
  await noted.service.runOrderFollowups();
  await noted.service.drainBackgroundTasks();

  const unreadable = makeContext({ orders: [retryCandidate(65)], hdAutoSend });
  unreadable.woo.request = async () => { throw new Error('notes down'); };
  await unreadable.service.runOrderFollowups();
  await unreadable.service.drainBackgroundTasks();

  assert.deepEqual(autoSends, []);
});

test('a reservation left behind by a clean send failure is cleared (so it is sent again), not counted as sent', async () => {
  const reservedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const order = baseOrder(32, { meta_data: meta({
    rhymat_whatsapp_confirmation_request_state: 'reserved',
    rhymat_whatsapp_confirmation_request_reserved_at: reservedAt,
    rhymat_whatsapp_confirmation_request_failed_for: reservedAt
  }) });
  const { service, sends, teamAlerts, metaOf } = makeContext({ orders: [order], notify: true });
  const summary = await service.runOrderFollowups();
  assert.equal(teamAlerts.length, 0);
  // Cleared, then the backfill sends the first message once.
  assert.equal(summary.backfilled, 1);
  assert.equal(sends.length, 1);
  assert.notEqual(metaOf(32, 'rhymat_whatsapp_confirmation_message_id'), 'unconfirmed_timeout');
});

test('a clean send failure is recorded on the order even when clearing the reservation fails', async () => {
  const order = baseOrder(33);
  const { service, woo, metaOf } = makeContext({ orders: [order] });
  service.wasenderClient.sendMessage = async () => { const error = new Error('rejected'); error.status = 500; throw error; };
  let writes = 0;
  const original = woo.updateOrderMeta;
  woo.updateOrderMeta = async (id, rows) => {
    writes += 1;
    if (writes === 2) {
      throw new Error('clear failed');
    }
    return original(id, rows);
  };
  await service.sendInitialConfirmation(structuredClone(order));
  assert.equal(metaOf(33, 'rhymat_whatsapp_confirmation_request_state'), 'reserved');
  assert.equal(metaOf(33, 'rhymat_whatsapp_confirmation_request_failed_for'), metaOf(33, 'rhymat_whatsapp_confirmation_request_reserved_at'));
});

test('the stale-send alert says the message may not have been sent', async () => {
  const reservedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const order = baseOrder(34, { meta_data: meta({ rhymat_whatsapp_reminder_1_state: 'reserved', rhymat_whatsapp_reminder_1_reserved_at: reservedAt, rhymat_whatsapp_state: 'pending', rhymat_whatsapp_confirmation_sent_at: new Date(Date.now() - 26 * HOUR).toISOString() }) });
  const { service, teamAlerts } = makeContext({ orders: [order], notify: true });
  await service.runOrderFollowups();
  assert.equal(teamAlerts.length, 1);
  assert.match(teamAlerts[0], /peut-etre PAS envoye/u);
});

test('withTransientRetry: only idempotent work is retried; a note or a create gets one attempt', async () => {
  const { service } = makeContext();
  const busy = () => new Error('WooCommerce request failed with 503: {"code":"busy"}');
  let reads = 0;
  const value = await service.withTransientRetry(async () => {
    reads += 1;
    if (reads < 3) {
      throw busy();
    }
    return 'ok';
  }, 'a read', { idempotent: true });
  assert.deepEqual([value, reads], ['ok', 3]);
  let notes = 0;
  await assert.rejects(service.withTransientRetry(async () => { notes += 1; throw busy(); }, 'an order note'), /503/u);
  assert.equal(notes, 1);
});

test('withTransientRetry: work the WooCommerce client already retries gets one attempt here', async () => {
  const { service } = makeContext();
  let reads = 0;
  await assert.rejects(service.withTransientRetry(async () => { reads += 1; throw new Error('WooCommerce request failed with 503: {}'); }, 'a GET', { idempotent: true, clientRetries: true }), /503/u);
  assert.equal(reads, 1);
});
