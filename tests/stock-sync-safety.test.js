import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStockPlan, computeTarget } from '../src/services/stock-sync-service.js';
import { HighDeliveryClient } from '../src/services/highdelivery-client.js';
import { WooCommerceClient } from '../src/services/woocommerce-client.js';
import { hasValidQuantity, loadProductMap } from '../src/services/hd-product-match.js';
import { resolveReserveLines } from '../src/services/order-resolver.js';
import { LINK_META, parseLinkDoc } from '../src/services/product-links.js';
import { FILLER, hdRows, linkDoc, linkUnit, makeService, makeShop, simpleProduct, wooProduct, wooVariation } from './helpers/fake-shop.js';

const quietLogger = { log() {}, warn() {}, error() {} };
const entry = (product) => ({ product, link: parseLinkDoc(product.meta_data[0]?.value || '') });
const plan = (products, { variations = {}, warehouse, reservations = new Map(), preview = false }) =>
  computeStockPlan({ products: products.map(entry), variationsByProduct: new Map(Object.entries(variations).map(([id, rows]) => [Number(id), rows])), warehouse, reservations, preview });
const item = (hdId, qty = 1) => ({ hd_id: hdId, hd_name: `HD item ${hdId}`, qty });
const targets = (rows) => Object.fromEntries(rows.map((row) => [`${row.productId}/${row.unit}`, row.target]));

// --- 1. one HighDelivery item read by several units ---

test('shared item: two products written here split the free pieces, never more than HighDelivery has', () => {
  const rows = plan([simpleProduct(100, 24, { stock: 0 }), simpleProduct(101, 24, { stock: 0 })], { warehouse: hdRows([24, 5]) });
  assert.deepEqual(targets(rows), { '100/p': 3, '101/p': 2 });
  assert.match(rows[0].why, /item 24 is shared: 5 free for 2 units written here, this unit gets 3 \(alone it would get 5\)/u);
});

test('shared item: the example from the review (HD 2, reserved 1, two sizes) shows one piece in total', () => {
  const product = wooProduct(7, { type: 'variable', doc: linkDoc({ 71: linkUnit(), 72: linkUnit() }) });
  const rows = plan([product], { variations: { 7: [wooVariation(71, 'a', { stock: 0 }), wooVariation(72, 'b', { stock: 0 })] }, warehouse: hdRows([512, 2]), reservations: new Map([[512, 1]]) });
  assert.equal(rows.reduce((sum, row) => sum + row.target, 0), 1);
});

test('shared item: stock shown by desktop-written, sync-off, held and bundle units is taken from the pool', () => {
  const desktop = simpleProduct(200, 24, { stock: 3, writer: 'desktop' });
  const syncOff = simpleProduct(201, 24, { stock: 1, unit: { sync: false } });
  const heldDesktop = simpleProduct(202, 24, { stock: 1, writer: 'desktop', unit: { hold: true } });
  const heldHere = simpleProduct(203, 24, { stock: 7, unit: { hold: true } }); // written to 0 by this run: takes nothing
  const bundle = simpleProduct(204, 24, { stock: 2, unit: { items: [item(24), item(25)] } });
  const mine = simpleProduct(100, 24, { stock: 0 });
  const rows = plan([desktop, syncOff, heldDesktop, heldHere, bundle, mine], { warehouse: hdRows([24, 10], [25, 10]) });
  const row = rows.find((r) => r.productId === 100);
  assert.equal(row.target, 3); // 10 - 3 - 1 - 1 - 2
  assert.match(row.why, /item 24 is shared: 3 free for 1 unit written here after 7 shown by other units, this unit gets 3 \(alone it would get 10\)/u);
  assert.equal(rows.find((r) => r.productId === 203).target, 0);
});

test('shared item: a parent-managed product counts its stock once for the item', () => {
  const doc = linkDoc({ 11: linkUnit({ items: [item(24)] }), 12: linkUnit({ items: [item(24)] }) });
  const parent = wooProduct(300, { type: 'variable', stock: 4, manage: true, doc });
  const mine = simpleProduct(100, 24, { stock: 0 });
  const rows = plan([parent, mine], { variations: { 300: [wooVariation(11, 'a', { manage: 'parent' }), wooVariation(12, 'b', { manage: 'parent' })] }, warehouse: hdRows([24, 10]) });
  assert.equal(rows.find((r) => r.productId === 100).target, 6);
});

test('shared item: two pieces per unit, the largest offset is kept back once', () => {
  const pair = simpleProduct(100, 24, { stock: 0, unit: { items: [item(24, 2)] } });
  const single = simpleProduct(101, 24, { stock: 0 });
  assert.deepEqual(targets(plan([pair, single], { warehouse: hdRows([24, 5]) })), { '100/p': 2, '101/p': 1 });
  const a = simpleProduct(100, 24, { stock: 0 });
  const b = simpleProduct(101, 24, { stock: 0, unit: { offset: 2 } });
  assert.deepEqual(targets(plan([a, b], { warehouse: hdRows([24, 6]) })), { '100/p': 2, '101/p': 2 });
});

test('a unit alone on its item keeps exactly the computeTarget answer and no sharing note', () => {
  for (const [hd, reserved, unit] of [[10, 2, { offset: 1, max_online: null }], [9, 0, { offset: 0, max_online: 4 }], [7, 1, { items: [item(24, 2)] }]]) {
    const product = simpleProduct(100, 24, { stock: 0, unit });
    const [row] = plan([product], { warehouse: hdRows([24, hd]), reservations: new Map([[24, reserved]]) });
    assert.equal(row.target, computeTarget(hd, reserved, { ...linkUnit({ items: [item(24)] }), ...unit }));
    assert.doesNotMatch(row.why, /shared/u);
  }
});

test('shared item: whatever the mix, the shop never shows more pieces than HighDelivery has free', () => {
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 300; round += 1) {
    const hd = random(12);
    const reserved = random(4);
    const products = Array.from({ length: 1 + random(4) }, (_, i) => simpleProduct(100 + i, 24, {
      stock: random(5),
      writer: random(4) === 0 ? 'desktop' : 'server',
      unit: { items: [item(24, 1 + random(2))], offset: random(3), max_online: random(3) === 0 ? random(4) : null }
    }));
    const rows = plan(products, { warehouse: hdRows([24, hd]), reservations: new Map([[24, reserved]]) });
    const docs = products.map((p) => entry(p).link.doc.units.p);
    let shown = 0;
    rows.forEach((row, i) => {
      const qty = docs[i].items[0].qty;
      if (['write', 'same'].includes(row.action)) {
        assert.ok(row.target <= computeTarget(hd, reserved, docs[i]));
        shown += row.target * qty;
      } else {
        shown += Math.max(0, products[i].stock_quantity) * qty;
      }
    });
    const writtenHere = rows.some((row) => ['write', 'same'].includes(row.action) && row.target > 0);
    if (writtenHere) {
      assert.ok(shown <= Math.max(0, hd - reserved), JSON.stringify({ hd, reserved, rows: rows.map((r) => [r.action, r.target, r.current]) }));
    }
  }
});

// --- 2. fresh HighDelivery read, orders first, a reservation that drops ---

test('the sync reads the open orders before HighDelivery, and HighDelivery never from its cache', async () => {
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 0 })], hd: [...FILLER, ...hdRows([24, 3])] });
  const sequence = [];
  const { listOpenOrdersLite } = shop.wooClient;
  shop.wooClient.listOpenOrdersLite = async (...args) => { sequence.push('orders'); return listOpenOrdersLite(...args); };
  const { listWarehouseProducts } = shop.hdClient;
  shop.hdClient.listWarehouseProducts = async (options) => { sequence.push(`hd ${JSON.stringify(options)}`); return listWarehouseProducts(options); };
  await makeService(shop).run();
  assert.deepEqual(sequence.slice(0, 2), ['orders', 'hd {"fresh":true}']);
});

test('HighDeliveryClient: fresh: true reads the warehouse again, the default keeps the one-minute cache', async () => {
  const reply = (data) => ({ status: 200, async json() { return { success: true, message: 'ok', data }; } });
  const replies = [reply({ token: 't' }), reply({ products: [{ id: 1, quantity_available: 3 }], total: 1 }), reply({ products: [{ id: 1, quantity_available: 1 }], total: 1 })];
  const calls = [];
  const client = new HighDeliveryClient({ phone: '0611111111', password: 'pw', logger: quietLogger, fetchImpl: async (url) => { calls.push(url); return replies.shift(); } });
  assert.equal((await client.listWarehouseProducts())[0].quantity_available, 3);
  assert.equal((await client.listWarehouseProducts())[0].quantity_available, 3);
  assert.equal((await client.listWarehouseProducts({ fresh: true }))[0].quantity_available, 1);
  assert.equal(calls.filter((url) => url.includes('/warehouse/products')).length, 2);
});

test('an open order leaving the list while the run is going also cancels it (reservation went down)', async () => {
  const order = { id: 5, status: 'processing', line_items: [{ name: 'x', quantity: 1, product_id: 100, variation_id: 0 }], meta_data: [] };
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 0 })], hd: [...FILLER, ...hdRows([24, 3])], orders: [order] });
  const original = shop.wooClient.listOpenOrdersLite;
  let reads = 0;
  shop.wooClient.listOpenOrdersLite = async (...args) => {
    const answer = await original(...args);
    reads += 1;
    return reads === 1 ? answer : { ...answer, orders: [] };
  };
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'orders_changed');
  assert.match(result.summary.abortDetail, /item 24 went from 1 to 0 reserved/u);
  assert.equal(shop.stockWrites().length, 0);
});

// --- 3. the stock is read again just before each write ---

test('a unit whose stock moved after the plan is not written and is reported as skipped_changed', async () => {
  const products = [simpleProduct(100, 24, { stock: 0 }), simpleProduct(101, 25, { stock: 0 })];
  const shop = makeShop({ products, hd: [...FILLER, ...hdRows([24, 3], [25, 3])] });
  const original = shop.wooClient.listOpenOrdersLite;
  let reads = 0;
  shop.wooClient.listOpenOrdersLite = async (...args) => {
    reads += 1;
    if (reads === 2) {
      shop.products.find((p) => p.id === 100).stock_quantity = 1; // a sale or a hand edit after the plan
    }
    return original(...args);
  };
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, '');
  assert.deepEqual([result.summary.changed, result.summary.skippedChanged], [1, 1]);
  assert.deepEqual(shop.stockWrites().map((w) => w.id), [101]);
  const row = result.plan.find((r) => r.productId === 100);
  assert.equal(row.action, 'skipped_changed');
  assert.match(row.why, /changed from 0 to 1/u);
  assert.equal(shop.products.find((p) => p.id === 100).stock_quantity, 1);
});

test('a variation whose stock moved after the plan is left out of the batch; the others are written', async () => {
  const product = wooProduct(7, { type: 'variable', doc: linkDoc({ 71: linkUnit({ items: [item(24)] }), 72: linkUnit({ items: [item(25)] }) }) });
  const variations = { 7: [wooVariation(71, 'a', { stock: 0 }), wooVariation(72, 'b', { stock: 0 })] };
  const shop = makeShop({ products: [product], variations, hd: [...FILLER, ...hdRows([24, 2], [25, 2])] });
  const original = shop.wooClient.listOpenOrdersLite;
  let reads = 0;
  shop.wooClient.listOpenOrdersLite = async (...args) => {
    reads += 1;
    if (reads === 2) { variations[7][0].stock_quantity = 4; }
    return original(...args);
  };
  const result = await makeService(shop).run();
  const batch = shop.writes.find((w) => w.kind === 'batch');
  assert.deepEqual(batch.updates.map((u) => u.id), [72]);
  assert.equal(result.summary.skippedChanged, 1);
});

// --- 4. open order lines that cannot be placed ---

const orderFor = (productId, variationId = 0, id = 31) => ({ id, status: 'processing', line_items: [{ name: `Line ${productId}`, quantity: 1, product_id: productId, variation_id: variationId }], meta_data: [] });

test('an open order of a product with an unreadable link document stops the run (orders_unresolved)', async () => {
  const broken = wooProduct(700, { docText: '{"schema":1,"kind":"linked"}' });
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 0 }), broken], hd: [...FILLER, ...hdRows([24, 3])], orders: [orderFor(700)] });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'orders_unresolved');
  assert.equal(result.summary.abortDetail, "order 31: the link document of 'Line 700' cannot be read (invalid)");
  assert.equal(shop.stockWrites().length, 0);
});

test('an open order of a size missing from a linked document (and not in the CSV) stops the run', async () => {
  const product = wooProduct(7, { type: 'variable', doc: linkDoc({ 71: linkUnit({ items: [item(24)] }) }) });
  const shop = makeShop({ products: [product], variations: { 7: [wooVariation(71, 'a', { stock: 0 }), wooVariation(79, 'new', { stock: 0 })] }, hd: [...FILLER, ...hdRows([24, 3])], orders: [orderFor(7, 79)] });
  assert.equal((await makeService(shop).run()).summary.aborted, 'orders_unresolved');
});

test('orders of unlinked, ignored and held products do not stop the run; a held unit with items still reserves them', async () => {
  const ignored = wooProduct(800, { doc: linkDoc({}, { kind: 'ignore' }) });
  const held = simpleProduct(801, 24, { stock: 0, unit: { hold: true } });
  const mine = simpleProduct(100, 24, { stock: 0 });
  const orders = [orderFor(4242, 0, 1), orderFor(800, 0, 2), orderFor(801, 0, 3)];
  const shop = makeShop({ products: [mine, ignored, held], hd: [...FILLER, ...hdRows([24, 3])], orders });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, '');
  assert.deepEqual([result.plan.find((r) => r.productId === 100).reserved, result.plan.find((r) => r.productId === 100).target], [1, 2]);
});

test('resolveReserveLines: what each kind of line reserves and which lines block', () => {
  const units = { '1:p': { kind: 'unit', unit: linkUnit({ items: [item(24, 2)] }) }, '2:p': { kind: 'ignore' }, '3:p': { kind: 'bad_doc', error: 'not_json' }, '4:p': { kind: 'unit', unit: linkUnit({ hold: true, items: [item(77)] }) } };
  const unitLookup = (productId) => units[`${productId}:p`] || { kind: 'none' };
  const linkKind = (productId) => ({ 5: 'linked' })[productId] || 'none';
  const csvMap = loadProductMap('woo_product_name,highdelivery_product_name\nOld,HD item 30\n');
  const line = (productId, name = `P${productId}`, quantity = 1) => ({ name, quantity, product_id: productId, variation_id: 0 });
  const { wanted, blocking } = resolveReserveLines([line(1, 'A', 3), line(2), line(3), line(4), line(6, 'Old'), line(9, 'Unknown'), line(5, 'Linked but no size')], { unitLookup, linkKind, csvMap, warehouse: hdRows([30, 1, 'HD item 30']) });
  assert.deepEqual([...wanted], [[24, 6], [77, 1], [30, 1]]);
  assert.equal(blocking.length, 2);
  assert.match(blocking[0], /link document of "P3" cannot be read \(not_json\)/u);
  assert.match(blocking[1], /"Linked but no size" is not in its product's link document/u);
});

// --- 5. the confirmed status is always reserved: see config-stock-sync.test.js ---

// --- 7. backorders ---

test('a unit that allows backorders is written with backorders "no", even when its stock is already right', async () => {
  const product = simpleProduct(100, 24, { stock: 3 });
  product.backorders = 'notify';
  const shop = makeShop({ products: [product], hd: [...FILLER, ...hdRows([24, 3])] });
  const result = await makeService(shop).run();
  const row = result.plan.find((r) => r.productId === 100);
  assert.deepEqual([row.action, row.target], ['write', 3]);
  assert.match(row.why, /backorders turned off$/u);
  assert.deepEqual([shop.stockWrites()[0].fields.backorders, shop.stockWrites()[0].fields.stock_quantity], ['no', 3]);
  product.backorders = 'no';
  assert.equal((await makeService(shop).run()).plan.find((r) => r.productId === 100).action, 'same');
});

// --- 8. an unexpected error ---

test('an unexpected error is recorded as an internal_error abort, saved in the history and told to the team', async () => {
  const sent = [];
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 0 })], hd: [] });
  shop.hdClient.listWarehouseProducts = async () => null; // not a list: the plan code throws a TypeError
  const result = await makeService(shop, { notify: async (m) => { sent.push(m); return 1; } }).run();
  assert.equal(result.summary.aborted, 'internal_error');
  assert.ok(result.summary.abortDetail.length > 0 && result.summary.abortDetail.length <= 120);
  assert.equal(shop.controlState().runs.at(-1).aborted, 'internal_error');
  assert.equal(sent.length, 1);
  assert.equal(shop.stockWrites().length, 0);
});

test('an alert that throws does not break the run report', async () => {
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 0 })], hd: [] });
  const result = await makeService(shop, { notify: async () => { throw new Error('wasender down'); } }).run();
  assert.equal(result.summary.aborted, 'hd_empty');
  assert.equal(shop.controlState().runs.length, 1);
});

// --- 9. smaller holes ---

test('a batch answer without one reply per variation is not counted as written', async () => {
  for (const answer of [{}, { update: [] }, { update: [{ id: 71 }] }, null]) {
    const product = wooProduct(7, { type: 'variable', doc: linkDoc({ 71: linkUnit({ items: [item(24)] }), 72: linkUnit({ items: [item(25)] }) }) });
    const shop = makeShop({ products: [product], variations: { 7: [wooVariation(71, 'a', { stock: 0 }), wooVariation(72, 'b', { stock: 0 })] }, hd: [...FILLER, ...hdRows([24, 2], [25, 2])] });
    shop.wooClient.batchUpdateVariations = async () => answer;
    const result = await makeService(shop).run();
    assert.equal(result.summary.aborted, 'write_failed', JSON.stringify(answer));
    assert.equal(result.summary.changed, answer?.update?.length || 0);
    assert.match(result.summary.abortDetail, /the shop did not confirm it/u);
  }
});

test('a grouped or external product is never written as if it had stock of its own', () => {
  for (const type of ['grouped', 'external']) {
    const product = wooProduct(9, { type, stock: 1, manage: true, doc: linkDoc({ p: linkUnit() }) });
    const [row] = plan([product], { warehouse: hdRows([512, 4]) });
    assert.deepEqual([row.action, row.target], ['skip_product_type', null]);
    assert.match(row.why, new RegExp(`a ${type} of this type has no stock of its own`, 'u'));
  }
});

test('the order list stops after 20 pages per status instead of looping forever', async () => {
  const calls = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', logger: quietLogger, sleepImpl: async () => {},
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, async text() { return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: calls.length * 1000 + i }))); } }; }
  });
  await assert.rejects(client.listOpenOrdersLite(['processing']), /order list for status "processing" is longer than 20 pages/u);
  assert.equal(calls.length, 20);
});

test('product and variation reads ask for the backorders field', async () => {
  const urls = [];
  const client = new WooCommerceClient({ baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', logger: quietLogger, fetchImpl: async (url) => { urls.push(new URL(url)); return { ok: true, status: 200, async text() { return '[]'; } }; } });
  await client.listAllProducts();
  await client.listVariations(5);
  assert.ok(urls.every((url) => url.searchParams.get('_fields').split(',').includes('backorders')));
});

test('hasValidQuantity takes whole numbers only', () => {
  for (const value of [0, '0', 7, ' 7 ', '-2', -2]) {
    assert.equal(hasValidQuantity({ quantity_available: value }), true, JSON.stringify(value));
  }
  for (const value of ['0x10', '1e3', '1.5', 1.5, '+3', 'Infinity', Infinity, NaN, '', ' ', null, undefined, true, '12abc', {}]) {
    assert.equal(hasValidQuantity({ quantity_available: value }), false, JSON.stringify(value));
  }
});

test('a pause set between two product writes stops the rest of the run', async () => {
  const products = [simpleProduct(100, 24, { stock: 0 }), simpleProduct(101, 25, { stock: 0 })];
  const shop = makeShop({ products, hd: [...FILLER, ...hdRows([24, 3], [25, 3])] });
  const original = shop.wooClient.updateProduct;
  shop.wooClient.updateProduct = async (id, fields) => {
    const answer = await original(id, fields);
    if (id === 100) {
      shop.products[0].meta_data.find((meta) => meta.key === LINK_META.control).value = JSON.stringify({ schema: 1, rev: 2, paused: true, ignored_hd_ids: [] });
    }
    return answer;
  };
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'mode_changed');
  assert.match(result.summary.abortDetail, /after 1 of 2 units were written/u);
  assert.deepEqual(shop.stockWrites().map((w) => w.id), [100]);
  assert.equal(result.summary.changed, 1);
});
