import test from 'node:test';
import assert from 'node:assert/strict';
import { HighDeliveryClient } from '../src/services/highdelivery-client.js';
import { HdAutoSendService, HD_META } from '../src/services/hd-auto-send-service.js';
import { describeItems, fold, loadProductMap, parseCsv, resolveWarehouseItems } from '../src/services/hd-product-match.js';

const quietLogger = { log() {}, warn() {}, error() {} };
const reply = (status, payload) => ({ status, async json() { return payload; } });
const ok = (data) => reply(200, { success: true, message: 'ok', data });

function scripted(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return replies.shift();
  };
  return { fetchImpl, calls };
}
const makeClient = (replies, extra = {}) => {
  const { fetchImpl, calls } = scripted(replies);
  return { client: new HighDeliveryClient({ phone: '0611111111', password: 'pw', fetchImpl, logger: quietLogger, ...extra }), calls };
};
const token = () => ok({ token: 't' });
const cityRows = (...names) => ok({ cities: names.map((name_fr, index) => ({ id: index + 1, name_fr })) });

const CSV = [
  'woo_product_name,woo_is_offer,highdelivery_product_name,component_role,size',
  "Cargo - S,no,Military Cargo S,pants,S",
  '"Pack, cargo + cap",yes,Military Cargo S,pants,S',
  '"Pack, cargo + cap",yes,Military cap,cap,',
  'Ghost,no,Does Not Exist,pants,S'
].join('\n');
const warehouse = [
  { id: 30, name: 'Military Cargo S', quantity_available: 9 },
  { id: 24, name: 'Military cap', quantity_available: 1 }
];

test('csv reader keeps quoted commas and the product map groups components', () => {
  assert.deepEqual(parseCsv('a,"b, c",d\n1,2,3').at(0), ['a', 'b, c', 'd']);
  const map = loadProductMap(CSV);
  assert.deepEqual(map.get(fold('Pack, cargo + cap')), ['Military Cargo S', 'Military cap']);
  assert.equal(fold("Khrej Mn L'Cadre – S"), 'khrej mn l cadre s');
});

test('order lines become warehouse items; a pack becomes its components', () => {
  const map = loadProductMap(CSV);
  const single = resolveWarehouseItems([{ name: 'Cargo - S', quantity: 2 }], map, warehouse);
  assert.deepEqual(single, { ok: true, items: [{ productId: 30, name: 'Military Cargo S', quantity: 2 }], problems: [] });
  const pack = resolveWarehouseItems([{ name: 'Pack, cargo + cap', quantity: 1 }], map, warehouse);
  assert.deepEqual(pack.items.map((i) => [i.productId, i.quantity]), [[30, 1], [24, 1]]);
  assert.equal(describeItems(pack.items), 'Military Cargo S (x1), Military cap (x1)');
});

test('an unmapped line, a missing warehouse product or too little stock is named', () => {
  const map = loadProductMap(CSV);
  const result = resolveWarehouseItems(
    [{ name: 'Mystery hoodie', quantity: 1 }, { name: 'Ghost', quantity: 1 }, { name: 'Pack, cargo + cap', quantity: 2 }], map, warehouse
  );
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' | '), /no HighDelivery product is mapped to "Mystery hoodie"/u);
  assert.match(result.problems.join(' | '), /"Does Not Exist" \(for "Ghost"\) is not in the HighDelivery warehouse/u);
  assert.match(result.problems.join(' | '), /not enough "Military cap" in the HighDelivery warehouse \(1 available, 2 needed\)/u);
});

test('createPackage names the warehouse stock products and quantities', async () => {
  const { client, calls } = makeClient([token(), cityRows('Casablanca'), ok({ id: 9, trackingNumber: 'NAI9' })]);
  const result = await client.createPackage({
    recipientName: 'A', recipientPhone: '0600000000', address: 'x', city: 'Casablanca', productName: 'Military cap (x1)', codAmount: 100,
    isExpress: true, items: [{ productId: 24, name: 'Military cap', quantity: 1 }]
  });
  assert.equal(result.trackingNumber, 'NAI9');
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/client/packages'));
  assert.equal(post.body.from_warehouse, true);
  assert.equal(post.body.is_express, true);
  assert.equal(post.body.isExpress, true); // the live API only reads this spelling
  assert.deepEqual(post.body.items, [{ source: 'warehouse', productId: 24, name: 'Military cap', quantity: 1, unitPrice: 0 }]);
});

test('warehouse products are read page by page, the phone check is parsed, a parcel can be cancelled', async () => {
  const { client, calls } = makeClient([
    token(),
    ok({ products: [{ id: 1, name: 'A', quantity_available: 3 }], total: 2 }),
    ok({ products: [{ id: 2, name: 'B', quantity_available: 0 }], total: 2 }),
    ok({ phone: '0600000000', trustScore: 72, totalOrders: 5, deliveredOrders: 4, failedOrders: 1, isBlacklisted: false }),
    ok({ id: 9, status: 'cancelled' })
  ]);
  assert.deepEqual((await client.listWarehouseProducts()).map((p) => p.id), [1, 2]);
  assert.deepEqual(await client.trustScore('+212 600 000 000'), { score: 72, totalOrders: 5, deliveredOrders: 4, failedOrders: 1, blacklisted: false });
  assert.ok(calls.some((c) => c.url.includes('/client/packages/trust-score?phone=212600000000')));
  assert.equal((await client.cancelPackage(9, 'test')).status, 'cancelled');
  assert.equal(calls.at(-1).method, 'PUT');
  assert.ok(calls.at(-1).url.endsWith('/client/packages/9/cancel'));
});

test('an old website spelling finds the HighDelivery city', async () => {
  const { client } = makeClient([token(), cityRows('Erfoud', 'Asilah')], { cityAliases: { arfoud: 'Erfoud', Assila: 'Asilah' } });
  assert.equal((await client.resolveCity('Arfoud')).name_fr, 'Erfoud');
  assert.equal((await client.resolveCity('ASSILA')).name_fr, 'Asilah');
  assert.equal(await client.resolveCity('Atlantis'), null);
});

function wooOrder(overrides = {}) {
  return {
    id: 777, status: 'on-hold', total: '264.00', meta_data: [],
    shipping: { first_name: 'Jane', last_name: 'Doe', address_1: 'Rue 1', city: 'Tétouan', phone: '0612345678' },
    billing: { first_name: 'Jane', last_name: 'Doe', phone: '0612345678' },
    line_items: [{ name: 'Cargo - S', quantity: 1 }],
    shipping_lines: [{ method_title: 'Cash on delivery', method_id: 'flexible_shipping_single' }],
    ...overrides
  };
}

function makeService({ order = wooOrder(), trust = { score: 50, totalOrders: 0, deliveredOrders: 0, failedOrders: 0, blacklisted: false }, trustThrows = false, minTrustScore = 30, stock = warehouse } = {}) {
  const events = [];
  const meta = [...(order.meta_data || [])];
  const wooClient = {
    async getOrder() { return { ...order, meta_data: [...meta] }; },
    async updateOrderMeta(id, rows) { events.push('reserve'); meta.push(...rows); return {}; },
    async updateOrderStatus(id, status) { events.push(`status:${status}`); return {}; },
    async addOrderNote(id, note) { events.push(`note:${note}`); return {}; }
  };
  const created = [];
  const hdClient = {
    isConfigured: () => true,
    async listWarehouseProducts() { return stock; },
    async trustScore() { if (trustThrows) { throw new Error('trust down'); } return trust; },
    async createPackage(parcel) { events.push('create'); created.push(parcel); return { trackingNumber: 'NAI7', data: {} }; }
  };
  const service = new HdAutoSendService({
    hdClient, wooClient, wasenderClient: { async sendMessage() { return {}; } }, store: {}, enabled: true, notifyPhones: [],
    template: 'x', productMap: loadProductMap(CSV), minTrustScore, logger: quietLogger
  });
  return { service, events, created };
}

test('auto-send hands HighDelivery the warehouse items, with express when the customer chose it', async () => {
  const { service, created, events } = makeService({
    order: wooOrder({ shipping_lines: [{ method_title: 'Livraison express', method_id: 'flexible_shipping_single' }], total: '290.00' })
  });
  const result = await service.autoSend({ orderId: '777' });
  assert.equal(result.status, 'sent');
  assert.deepEqual(created[0].items, [{ productId: 30, name: 'Military Cargo S', quantity: 1 }]);
  assert.equal(created[0].productName, 'Military Cargo S (x1)');
  assert.equal(created[0].isExpress, true);
  assert.ok(events.some((e) => e.startsWith('note:Sent to HighDelivery automatically. Tracking: NAI7 (express). Customer trust score: 50')));
});

test('a blacklisted or low-scoring number is held: no reservation, no parcel, a note says why', async () => {
  for (const trust of [{ score: 10, totalOrders: 4, deliveredOrders: 0, failedOrders: 4, blacklisted: false }, { score: 90, totalOrders: 1, deliveredOrders: 1, failedOrders: 0, blacklisted: true }]) {
    const { service, events, created } = makeService({ trust });
    const result = await service.autoSend({ orderId: '777' });
    assert.equal(result.status, 'held');
    assert.equal(created.length, 0);
    assert.ok(!events.includes('reserve'));
    assert.ok(events.some((e) => e.startsWith('note:Auto-send to HighDelivery held for review')));
  }
});

test('if the phone check itself is down, a good order still goes', async () => {
  const { service, created } = makeService({ trustThrows: true });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
  assert.equal(created.length, 1);
});

test('an order that cannot be matched to warehouse stock stays on-hold untouched', async () => {
  for (const order of [wooOrder({ line_items: [{ name: 'Mystery hoodie', quantity: 1 }] }), wooOrder({ line_items: [{ name: 'Cargo - S', quantity: 50 }] })]) {
    const { service, events, created } = makeService({ order });
    const result = await service.autoSend({ orderId: '777' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no_warehouse_match');
    assert.equal(created.length, 0);
    assert.ok(!events.includes('reserve'));
    assert.ok(events.some((e) => e.startsWith('note:Auto-send to HighDelivery skipped:') && e.includes('desktop app')));
  }
});

test('the never-twice guard still holds with the new checks', async () => {
  const { service, created } = makeService({ order: wooOrder({ meta_data: [{ key: HD_META.state, value: 'sent' }] }) });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'skipped');
  assert.equal(created.length, 0);
});
