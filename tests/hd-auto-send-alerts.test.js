import test from 'node:test';
import assert from 'node:assert/strict';
import { HighDeliveryError } from '../src/services/highdelivery-client.js';
import { HD_META, HdAutoSendService } from '../src/services/hd-auto-send-service.js';

const quietLogger = { log() {}, warn() {}, error() {} };
const PHONES = ['+212611111111', '+491700000000'];

const wooOrder = (extra = {}) => ({
  id: 901,
  status: 'on-hold',
  total: '399',
  currency: 'MAD',
  billing: { first_name: 'Jane', last_name: 'Doe', phone: '0612345678', city: 'Rabat', address_1: 'Rue 1' },
  shipping: { first_name: 'Jane', last_name: 'Doe', phone: '0612345678', city: 'Rabat', address_1: 'Rue 1' },
  line_items: [{ name: 'Hoodie M', quantity: 1 }],
  meta_data: [],
  ...extra
});

function makeService({ order = wooOrder(), trust = { score: 80, blacklisted: false, totalOrders: 3, deliveredOrders: 3, failedOrders: 0 }, create, statusFails = false } = {}) {
  const sent = [];
  const service = new HdAutoSendService({
    hdClient: {
      isConfigured: () => true,
      trustScore: async () => trust,
      createPackage: create || (async () => ({ trackingNumber: 'NAI000900' }))
    },
    wooClient: {
      getOrder: async () => order,
      updateOrderMeta: async () => ({}),
      addOrderNote: async () => ({}),
      updateOrderStatus: async () => { if (statusFails) throw new Error('woo down'); }
    },
    wasenderClient: { sendMessage: async (payload) => { sent.push(payload); return { success: true }; } },
    store: { appendMessage() {}, upsertOrder() {} },
    notifyPhones: PHONES,
    template: 'SENT {{orderId}} {{trackingNumber}}',
    manualTemplate: 'MANUAL {{orderId}} {{customerName}} {{problem}}',
    errorTemplate: 'ERROR {{orderId}} {{problem}}',
    enabled: true,
    minTrustScore: 30,
    logger: quietLogger
  });
  return { service, sent };
}

const texts = (sent) => sent.map((row) => row.message);

test('a sent order alerts both team phones once, with the tracking number', async () => {
  const { service, sent } = makeService();
  const outcome = await service.autoSend({ orderId: '901' });
  assert.equal(outcome.status, 'sent');
  assert.deepEqual(sent.map((row) => row.to), PHONES);
  assert.deepEqual(texts(sent), ['SENT 901 NAI000900', 'SENT 901 NAI000900']);
});

test('a low-trust number is held and both phones are told to send it manually', async () => {
  const { service, sent } = makeService({ trust: { score: 10, blacklisted: false, totalOrders: 4, deliveredOrders: 1, failedOrders: 3 } });
  const outcome = await service.autoSend({ orderId: '901' });
  assert.equal(outcome.status, 'held');
  assert.deepEqual(sent.map((row) => row.to), PHONES);
  assert.match(texts(sent)[0], /^MANUAL 901 Jane Doe numero a risque \(score 10\)/u);
});

test('an incomplete order (no usable phone) is a manual alert', async () => {
  const { service, sent } = makeService({ order: wooOrder({ billing: { first_name: 'Jane', city: 'Rabat' }, shipping: {} }) });
  const outcome = await service.autoSend({ orderId: '901' });
  assert.equal(outcome.reason, 'invalid_order');
  assert.equal(sent.length, 2);
  assert.match(texts(sent)[0], /^MANUAL 901/u);
});

test('HighDelivery refusing the parcel is an error alert', async () => {
  const { service, sent } = makeService({ create: async () => { throw new HighDeliveryError('Sélectionnez au moins un produit', { status: 400 }); } });
  const outcome = await service.autoSend({ orderId: '901' });
  assert.equal(outcome.status, 'failed');
  assert.equal(sent.length, 2);
  assert.match(texts(sent)[0], /^ERROR 901 HighDelivery a refuse: .*Sélectionnez/u);
});

test('no answer from HighDelivery says to check before sending again', async () => {
  const { service, sent } = makeService({ create: async () => { throw new HighDeliveryError('Could not reach HighDelivery', { ambiguous: true }); } });
  const outcome = await service.autoSend({ orderId: '901' });
  assert.equal(outcome.status, 'unknown');
  assert.match(texts(sent)[0], /verifier avant de renvoyer/u);
});

test('parcel sent but Woo not completed raises an error alert on top of the sent alert', async () => {
  const { service, sent } = makeService({ statusFails: true });
  const outcome = await service.autoSend({ orderId: '901' });
  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.completed, false);
  const all = texts(sent);
  assert.equal(all.filter((text) => text.startsWith('SENT')).length, 2);
  assert.equal(all.filter((text) => text.startsWith('ERROR 901 colis envoye')).length, 2);
});

test('nothing to act on stays silent: already sent, or handled by someone else', async () => {
  const done = makeService({ order: wooOrder({ meta_data: [{ key: HD_META.state, value: 'sent' }] }) });
  assert.equal((await done.service.autoSend({ orderId: '901' })).reason, 'already_sent');
  assert.equal(done.sent.length, 0);
  const handled = makeService({ order: wooOrder({ status: 'completed' }) });
  assert.equal((await handled.service.autoSend({ orderId: '901' })).reason, 'status_completed');
  assert.equal(handled.sent.length, 0);
});

test('without alert templates the send still works and nothing extra is sent', async () => {
  const { service, sent } = makeService({ trust: { score: 5, blacklisted: true, totalOrders: 1, deliveredOrders: 0, failedOrders: 1 } });
  service.manualTemplate = '';
  assert.equal((await service.autoSend({ orderId: '901' })).status, 'held');
  assert.equal(sent.length, 0);
});
