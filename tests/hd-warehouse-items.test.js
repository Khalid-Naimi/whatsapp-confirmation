import test from 'node:test';
import assert from 'node:assert/strict';
import { HighDeliveryClient } from '../src/services/highdelivery-client.js';
import { HdAutoSendService, HD_META } from '../src/services/hd-auto-send-service.js';
import { describeItems, fold, loadProductMap, parseCsv, resolveWarehouseItems } from '../src/services/hd-product-match.js';
import { LinkIndex } from '../src/services/link-index.js';
import { linkDoc, linkUnit, wooProduct } from './helpers/link-fixtures.js';

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

function makeService({ order = wooOrder(), trust = { score: 50, totalOrders: 0, deliveredOrders: 0, failedOrders: 0, blacklisted: false }, trustThrows = false, minTrustScore = 30, stock = warehouse, linkIndex = null, linksMode = 'off', logger = quietLogger } = {}) {
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
    template: 'x', productMap: loadProductMap(CSV), linkIndex, linksMode, minTrustScore, logger,
    // No 1 s wait after the reservation in tests (the cross-instance claim, services/claim.js).
    claimSettleMs: 0
  });
  // The HighDelivery state the order ends with (the last one written).
  const finalState = () => meta.filter((row) => row.key === HD_META.state).at(-1)?.value ?? '';
  return { service, events, created, finalState };
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

// The reservation is taken before the warehouse and trust calls (two instances must not both get that far), so a held
// order is reserved and then released: it ends with no HighDelivery state, as before.
test('a blacklisted or low-scoring number is held: reservation released, no parcel, a note says why', async () => {
  for (const trust of [{ score: 10, totalOrders: 4, deliveredOrders: 0, failedOrders: 4, blacklisted: false }, { score: 90, totalOrders: 1, deliveredOrders: 1, failedOrders: 0, blacklisted: true }]) {
    const { service, events, created, finalState } = makeService({ trust });
    const result = await service.autoSend({ orderId: '777' });
    assert.equal(result.status, 'held');
    assert.equal(created.length, 0);
    assert.deepEqual(events.filter((e) => e === 'reserve'), ['reserve', 'reserve']);
    assert.equal(finalState(), '');
    assert.ok(events.some((e) => e.startsWith('note:Auto-send to HighDelivery held for review')));
  }
});

test('if the phone check itself is down, a good order still goes', async () => {
  const { service, created } = makeService({ trustThrows: true });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
  assert.equal(created.length, 1);
});

test('an order that cannot be matched to warehouse stock stays on-hold, its reservation released', async () => {
  for (const order of [wooOrder({ line_items: [{ name: 'Mystery hoodie', quantity: 1 }] }), wooOrder({ line_items: [{ name: 'Cargo - S', quantity: 50 }] })]) {
    const { service, events, created, finalState } = makeService({ order });
    const result = await service.autoSend({ orderId: '777' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no_warehouse_match');
    assert.equal(created.length, 0);
    assert.deepEqual(events.filter((e) => e === 'reserve'), ['reserve', 'reserve']);
    assert.equal(finalState(), '');
    assert.ok(events.some((e) => e.startsWith('note:Auto-send to HighDelivery skipped:') && e.includes('desktop app')));
  }
});

test('the never-twice guard still holds with the new checks', async () => {
  const { service, created } = makeService({ order: wooOrder({ meta_data: [{ key: HD_META.state, value: 'sent' }] }) });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'skipped');
  assert.equal(created.length, 0);
});

test('only the website\'s fast option is express: Casablanca same-day stays standard', async () => {
  const run = async (shippingLine) => {
    const { service, created } = makeService({ order: wooOrder({ shipping_lines: [shippingLine] }) });
    assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
    return created[0].isExpress;
  };
  const tag = (value, title) => ({ method_title: title, method_id: 'flexible_shipping_single', meta_data: [{ key: 'rhymat_delivery', value }] });
  assert.equal(await run(tag('fast', 'Livraison le jour même')), true);
  assert.equal(await run(tag('fast', 'Livraison express')), true);
  assert.equal(await run(tag('casa', 'Livraison le jour même')), false);
  assert.equal(await run(tag('standard', 'Livraison 2 à 3 jours')), false);
  assert.equal(await run({ method_title: 'Livraison express', method_id: 'flexible_shipping_single' }), true); // order from before the tag existed
  assert.equal(await run({ method_title: 'Cash on delivery', method_id: 'flexible_shipping_single' }), false);
});

// --- product links (HD_LINKS_FOR_ORDERS) ---

const settle = () => new Promise((resolve) => setImmediate(resolve));
const linkWarehouse = [...warehouse, { id: 512, name: 'Zip up Hoodie Saumon XL', quantity_available: 4 }];
const linkedOrder = (overrides = {}) => wooOrder({ line_items: [{ name: 'Cargo - S', quantity: 1, product_id: 8974, variation_id: 8978 }], ...overrides });

function makeLinkIndex(unit, { failRead = false } = {}) {
  const reads = [];
  const product = wooProduct(8974, { type: 'variable', doc: linkDoc({ 8978: unit }) });
  const wooClient = { async getProduct(id) { reads.push(id); if (failRead) { throw new Error('woo down'); } return product; } };
  return { linkIndex: new LinkIndex({ wooClient }), reads };
}
const linkedToSaumon = () => linkUnit({ items: [{ hd_id: 512, hd_name: 'Zip up Hoodie Saumon XL', qty: 1 }] });

test('links off: the product links are never read and the CSV decides', async () => {
  const { linkIndex, reads } = makeLinkIndex(linkedToSaumon());
  const { service, created } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'off' });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
  assert.deepEqual(created[0].items, [{ productId: 30, name: 'Military Cargo S', quantity: 1 }]);
  assert.equal(reads.length, 0);
});

test('links shadow: the CSV still decides, a difference is logged with ids only', async () => {
  const logs = [];
  const { linkIndex } = makeLinkIndex(linkedToSaumon());
  const { service, created } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'shadow', logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error() {} } });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
  await settle();
  assert.deepEqual(created[0].items, [{ productId: 30, name: 'Military Cargo S', quantity: 1 }]);
  const line = logs.find((m) => m.startsWith('[hd-links]'));
  assert.equal(line, '[hd-links] shadow orderId=777 same=false csv=30x1 link=512x1');
  assert.doesNotMatch(logs.join('\n'), /Jane|Doe|0612|Rue 1|Tétouan/u);
});

test('links shadow: when both agree the log says so', async () => {
  const logs = [];
  const { linkIndex } = makeLinkIndex(linkUnit({ items: [{ hd_id: 30, hd_name: 'Military Cargo S', qty: 1 }] }));
  const { service } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'shadow', logger: { log: (m) => logs.push(m), warn() {}, error() {} } });
  await service.autoSend({ orderId: '777' });
  await settle();
  assert.ok(logs.includes('[hd-links] shadow orderId=777 same=true csv=30x1 link=30x1'));
});

test('links shadow never changes the outcome, even when the link lookup fails or would hold the order', async () => {
  for (const setup of [makeLinkIndex(linkedToSaumon(), { failRead: true }), makeLinkIndex(linkUnit({ hold: true, items: [] }))]) {
    const { service, created } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex: setup.linkIndex, linksMode: 'shadow' });
    const result = await service.autoSend({ orderId: '777' });
    assert.equal(result.status, 'sent');
    assert.deepEqual(created[0].items, [{ productId: 30, name: 'Military Cargo S', quantity: 1 }]);
  }
});

test('links on: the linked HighDelivery item is sent, whatever the CSV says', async () => {
  const { linkIndex } = makeLinkIndex(linkedToSaumon());
  const { service, created } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'on' });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
  assert.deepEqual(created[0].items, [{ productId: 512, name: 'Zip up Hoodie Saumon XL', quantity: 1 }]);
});

test('links on: a product without a link still goes through the CSV', async () => {
  const order = wooOrder({ line_items: [{ name: 'Cargo - S', quantity: 1, product_id: 55, variation_id: 0 }] });
  const linkIndex = new LinkIndex({ wooClient: { async getProduct() { return wooProduct(55, {}); } } });
  const { service, created } = makeService({ order, stock: linkWarehouse, linkIndex, linksMode: 'on' });
  assert.equal((await service.autoSend({ orderId: '777' })).status, 'sent');
  assert.equal(created[0].items[0].productId, 30);
});

test('links on: a hold unit keeps the order on-hold for a human', async () => {
  const { linkIndex } = makeLinkIndex(linkUnit({ hold: true, items: [] }));
  const { service, created, events } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'on' });
  const result = await service.autoSend({ orderId: '777' });
  assert.deepEqual([result.status, result.reason], ['skipped', 'no_warehouse_match']);
  assert.equal(created.length, 0);
  assert.ok(events.some((e) => e.startsWith('note:') && e.includes('is on hold')));
});

test('links on: if the links cannot be read the order is held, not sent by guess', async () => {
  const { linkIndex } = makeLinkIndex(linkedToSaumon(), { failRead: true });
  const { service, created } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'on' });
  const result = await service.autoSend({ orderId: '777' });
  assert.deepEqual([result.status, result.reason], ['skipped', 'stock_read_failed']);
  assert.equal(created.length, 0);
});

test('links shadow never delays the send: a link lookup that never answers changes nothing', async () => {
  const linkIndex = new LinkIndex({ wooClient: { getProduct: () => new Promise(() => {}) } });
  const { service, created } = makeService({ order: linkedOrder(), stock: linkWarehouse, linkIndex, linksMode: 'shadow' });
  const result = await Promise.race([service.autoSend({ orderId: '777' }), new Promise((resolve) => setTimeout(() => resolve('waited'), 500))]);
  assert.equal(result.status, 'sent');
  assert.deepEqual(created[0].items, [{ productId: 30, name: 'Military Cargo S', quantity: 1 }]);
});

// --- paging without a total ---

const stockRows = (count, start = 1) => Array.from({ length: count }, (_, i) => ({ id: start + i, name: `Item ${start + i}`, quantity_available: 1 }));

test('warehouse paging without a total keeps going until a short page', async () => {
  const { client, calls } = makeClient([token(), ok({ products: stockRows(100) }), ok({ products: stockRows(100, 101) }), ok({ products: stockRows(7, 201) })]);
  assert.equal((await client.listWarehouseProducts()).length, 207);
  assert.equal(calls.filter((call) => call.url.includes('/warehouse/products')).length, 3);
});

test('warehouse paging with a total of 0 is treated like no total', async () => {
  const { client } = makeClient([token(), ok({ products: stockRows(100), total: 0 }), ok({ products: stockRows(2, 101), total: 0 })]);
  assert.equal((await client.listWarehouseProducts()).length, 102);
});

test('warehouse paging stops at the reported total, and a list that never ends is an error, not a silent cut', async () => {
  const exact = makeClient([token(), ok({ products: stockRows(100), total: 100 })]);
  assert.equal((await exact.client.listWarehouseProducts()).length, 100);
  const endless = makeClient([token(), ...Array.from({ length: 20 }, () => ok({ products: stockRows(100) }))]);
  await assert.rejects(endless.client.listWarehouseProducts(), /longer than 20 pages/u);
});
