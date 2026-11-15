import test from 'node:test';
import assert from 'node:assert/strict';
import { HighDeliveryClient } from '../src/services/highdelivery-client.js';
import { HD_META, HdAutoSendService } from '../src/services/hd-auto-send-service.js';

const quiet = { log() {}, warn() {}, error() {} };

// A fetch that answers the login, the city list, then the parcel creation with what the test wants.
function hdFetch(createAnswer) {
  return async (url, options) => {
    if (url.endsWith('/auth/login')) {
      return { status: 200, json: async () => ({ success: true, data: { token: 't' } }) };
    }
    if (url.includes('/cities')) {
      return { status: 200, json: async () => ({ success: true, data: { cities: [{ id: 1, name_fr: 'Casablanca' }] } }) };
    }
    if (url.endsWith('/client/packages') && options.method === 'POST') {
      return createAnswer();
    }
    throw new Error(`unexpected ${url}`);
  };
}

const parcel = { recipientName: 'A', recipientPhone: '0612345678', address: 'Rue 1', city: 'Casablanca', productName: 'Tee x1', codAmount: 100 };

test('a 5xx answer to the parcel creation is ambiguous (the parcel may exist)', async () => {
  const client = new HighDeliveryClient({ phone: 'p', password: 'x', fetchImpl: hdFetch(() => ({ status: 502, json: async () => ({ success: false, message: 'Bad gateway' }) })), logger: quiet });
  await assert.rejects(client.createPackage(parcel), (error) => error.ambiguous === true && error.status === 502);
});

test('an unreadable answer to the parcel creation is ambiguous', async () => {
  const client = new HighDeliveryClient({ phone: 'p', password: 'x', fetchImpl: hdFetch(() => ({ status: 200, json: async () => { throw new Error('html'); } })), logger: quiet });
  await assert.rejects(client.createPackage(parcel), (error) => error.ambiguous === true);
});

test('a clean refusal (4xx with a JSON answer) is still a plain failure', async () => {
  const client = new HighDeliveryClient({ phone: 'p', password: 'x', fetchImpl: hdFetch(() => ({ status: 400, json: async () => ({ success: false, message: 'Adresse invalide' }) })), logger: quiet });
  await assert.rejects(client.createPackage(parcel), (error) => error.ambiguous === false && error.status === 400);
});

test('reads and the login are never ambiguous, even on a 5xx', async () => {
  const down = async () => ({ status: 503, json: async () => { throw new Error('html'); } });
  const client = new HighDeliveryClient({ phone: 'p', password: 'x', fetchImpl: down, logger: quiet, sleepImpl: async () => {} });
  await assert.rejects(client.login(), (error) => error.ambiguous === false);
  client.token = 't';
  await assert.rejects(client.listCities(), (error) => error.ambiguous === false);
});

test('the auto-send marks the order unknown, not failed, when HighDelivery answers 5xx', async () => {
  const order = { id: 9, status: 'on-hold', total: '100', billing: { first_name: 'A', phone: '0612345678', city: 'Casablanca', address_1: 'Rue 1' }, line_items: [{ name: 'Tee', quantity: 1 }], meta_data: [] };
  const meta = [];
  const wooClient = {
    async getOrder() { return { ...order, meta_data: [...meta] }; },
    async updateOrderMeta(id, rows) { for (const row of rows) { const at = meta.findIndex((m) => m.key === row.key); if (at >= 0) { meta[at] = row; } else { meta.push(row); } } return {}; },
    async addOrderNote() { return {}; },
    async updateOrderStatus() { throw new Error('must not complete'); }
  };
  const hdClient = new HighDeliveryClient({ phone: 'p', password: 'x', fetchImpl: hdFetch(() => ({ status: 500, json: async () => ({ success: false, message: 'Server Error' }) })), logger: quiet, sleepImpl: async () => {} });
  const service = new HdAutoSendService({ hdClient, wooClient, wasenderClient: { async sendMessage() { return {}; } }, enabled: true, logger: quiet });
  const outcome = await service.autoSend({ orderId: '9' });
  assert.equal(outcome.status, 'unknown');
  assert.equal(meta.find((m) => m.key === HD_META.state).value, 'unknown');
  assert.ok(Date.parse(meta.find((m) => m.key === HD_META.sendingAt).value) > 0);
});

function stuckService({ state = 'sending', sendingAt }) {
  const meta = [{ key: HD_META.state, value: state }];
  if (sendingAt !== undefined) {
    meta.push({ key: HD_META.sendingAt, value: sendingAt });
  }
  const order = { id: 31, status: 'on-hold', billing: { first_name: 'B', phone: '0612345678' }, line_items: [], meta_data: meta };
  const notes = [];
  const alerts = [];
  const wooClient = {
    async getOrder() { return structuredClone(order); },
    async updateOrderMeta(id, rows) { for (const row of rows) { const at = order.meta_data.findIndex((m) => m.key === row.key); if (at >= 0) { order.meta_data[at] = row; } else { order.meta_data.push(row); } } return order; },
    async addOrderNote(id, note) { notes.push(note); return {}; }
  };
  const service = new HdAutoSendService({
    hdClient: { isConfigured: () => true },
    wooClient,
    wasenderClient: { async sendMessage(payload) { alerts.push(payload); return { id: 'a' }; } },
    notifyPhones: ['+212700000000'],
    errorTemplate: 'ERREUR {{orderId}} {{problem}}',
    enabled: true,
    logger: quiet
  });
  return { service, order, notes, alerts };
}

test('a "sending" older than 10 minutes becomes "unknown", gets a note and alerts the team once', async () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const { service, order, notes, alerts } = stuckService({ sendingAt: '2026-11-15T11:45:00Z' });
  assert.equal(await service.reviewStuckSend(structuredClone(order), now), true);
  assert.equal(order.meta_data.find((m) => m.key === HD_META.state).value, 'unknown');
  assert.equal(notes.length, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /ERREUR 31/u);
  // Next hour: it is "unknown" now, so nothing happens again.
  assert.equal(await service.reviewStuckSend(structuredClone(order), now), false);
  assert.equal(alerts.length, 1);
});

test('a recent "sending", one running in this process, or another state is left alone', async () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const recent = stuckService({ sendingAt: '2026-11-15T11:55:00Z' });
  assert.equal(await recent.service.reviewStuckSend(structuredClone(recent.order), now), false);
  const running = stuckService({ sendingAt: '2026-11-15T11:00:00Z' });
  running.service.inFlight.add('31');
  assert.equal(await running.service.reviewStuckSend(structuredClone(running.order), now), false);
  const sent = stuckService({ state: 'sent', sendingAt: '2026-11-15T11:00:00Z' });
  assert.equal(await sent.service.reviewStuckSend(structuredClone(sent.order), now), false);
});

test('a "sending" from before the start time existed counts as stuck', async () => {
  const { service, order } = stuckService({});
  assert.equal(await service.reviewStuckSend(structuredClone(order), new Date()), true);
  assert.equal(order.meta_data.find((m) => m.key === HD_META.state).value, 'unknown');
});
