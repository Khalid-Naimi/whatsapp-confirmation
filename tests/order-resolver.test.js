import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProductMap } from '../src/services/hd-product-match.js';
import { LinkIndex } from '../src/services/link-index.js';
import { buildUnitLookup, describeResolution, resolveOrderItems } from '../src/services/order-resolver.js';
import { linkDoc, linkUnit, wooProduct } from './helpers/link-fixtures.js';

const CSV = [
  'woo_product_name,woo_is_offer,highdelivery_product_name,component_role,size',
  'Cargo - S,no,Military Cargo S,pants,S',
  '"Pack, cargo + cap",yes,Military Cargo S,pants,S',
  '"Pack, cargo + cap",yes,Military cap,cap,'
].join('\n');
const csvMap = loadProductMap(CSV);
const warehouse = [
  { id: 30, name: 'Military Cargo S', quantity_available: 9 },
  { id: 24, name: 'Military cap', quantity_available: 3 },
  { id: 512, name: 'Zip up Hoodie Saumon XL', quantity_available: 2 }
];

// A lookup answering from a plain table: 'productId:variationId' -> lookup result.
const table = (rows) => (productId, variationId) => rows[`${productId}:${variationId || 0}`] || { kind: 'none' };
const resolve = (lines, rows = {}) => resolveOrderItems(lines, { unitLookup: table(rows), csvMap, warehouse });

test('a linked line takes the HighDelivery item by id, times the line quantity and the item quantity', () => {
  const unit = linkUnit({ items: [{ hd_id: 24, hd_name: 'old name', qty: 2 }] });
  const result = resolve([{ name: 'Whatever the shop calls it', quantity: 1, product_id: 8974, variation_id: 8978 }], { '8974:8978': { kind: 'unit', unit } });
  assert.deepEqual(result, { ok: true, items: [{ productId: 24, name: 'Military cap', quantity: 2 }], problems: [], via: { link: 1, csv: 0 } });
});

test('a link reaches the item even when the HighDelivery name changed', () => {
  const unit = linkUnit({ items: [{ hd_id: 512, hd_name: 'Name from last month', qty: 1 }] });
  const result = resolve([{ name: 'Saumon XS', quantity: 1, product_id: 8974, variation_id: 8978 }], { '8974:8978': { kind: 'unit', unit } });
  assert.equal(result.items[0].name, 'Zip up Hoodie Saumon XL');
});

test('a product without a link falls back to the CSV by name', () => {
  const result = resolve([{ name: 'Cargo - S', quantity: 2, product_id: 1, variation_id: 0 }]);
  assert.deepEqual(result.items, [{ productId: 30, name: 'Military Cargo S', quantity: 2 }]);
  assert.deepEqual(result.via, { link: 0, csv: 1 });
});

test('a pack that is only in the CSV still becomes its components', () => {
  const result = resolve([{ name: 'Pack, cargo + cap', quantity: 1, product_id: 2, variation_id: 0 }]);
  assert.deepEqual(result.items.map((i) => [i.productId, i.quantity]), [[30, 1], [24, 1]]);
});

test('linked and CSV lines asking for the same item are added up before the stock check', () => {
  const unit = linkUnit({ items: [{ hd_id: 30, hd_name: 'Military Cargo S', qty: 1 }] });
  const result = resolve(
    [{ name: 'Linked cargo', quantity: 5, product_id: 3, variation_id: 0 }, { name: 'Cargo - S', quantity: 5, product_id: 4, variation_id: 0 }],
    { '3:0': { kind: 'unit', unit } }
  );
  assert.equal(result.ok, false);
  assert.match(result.problems.join('|'), /not enough "Military Cargo S" in the HighDelivery warehouse \(9 available, 10 needed\)/u);
});

test('a hold unit is a problem, not a silent skip', () => {
  const unit = linkUnit({ hold: true, items: [] });
  const result = resolve([{ name: 'Burgundy hoodie', quantity: 1, product_id: 8968, variation_id: 8969 }], { '8968:8969': { kind: 'unit', unit } });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /"Burgundy hoodie" is on hold/u);
  assert.equal(describeResolution(result), 'held');
});

test('a linked item that no longer exists in the warehouse is named', () => {
  const unit = linkUnit({ items: [{ hd_id: 999, hd_name: 'Gone hoodie', qty: 1 }] });
  const result = resolve([{ name: 'Hoodie', quantity: 1, product_id: 5, variation_id: 0 }], { '5:0': { kind: 'unit', unit } });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /HighDelivery item 999 \("Gone hoodie"\) linked to "Hoodie" no longer exists/u);
});

test('a link whose item is short of stock holds the order like the CSV path does', () => {
  const unit = linkUnit({ items: [{ hd_id: 512, hd_name: 'x', qty: 1 }] });
  const result = resolve([{ name: 'Saumon XS', quantity: 3, product_id: 8974, variation_id: 8978 }], { '8974:8978': { kind: 'unit', unit } });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /2 available, 3 needed/u);
});

test('an ignored product and an unreadable document hold the order', () => {
  const ignored = resolve([{ name: 'Gift card', quantity: 1, product_id: 6, variation_id: 0 }], { '6:0': { kind: 'ignore' } });
  assert.match(ignored.problems[0], /not a HighDelivery product/u);
  const broken = resolve([{ name: 'Hoodie', quantity: 1, product_id: 7, variation_id: 0 }], { '7:0': { kind: 'bad_doc', error: 'schema_unsupported' } });
  assert.match(broken.problems[0], /cannot be read \(schema_unsupported\)/u);
});

test('describeResolution lists ids and counts only', () => {
  const result = resolve([{ name: 'Pack, cargo + cap', quantity: 2, product_id: 2, variation_id: 0 }]);
  assert.equal(describeResolution(result), '24x2,30x2');
});

// --- LinkIndex ---

function makeIndex(products, { ttlMs = 600000, clock = { now: 0 } } = {}) {
  const reads = { all: 0, one: [] };
  const wooClient = {
    async listAllProducts() { reads.all += 1; return products; },
    async getProduct(id) { reads.one.push(String(id)); return products.find((p) => String(p.id) === String(id)); }
  };
  return { index: new LinkIndex({ wooClient, ttlMs, now: () => clock.now }), reads, clock };
}

const saumon = wooProduct(8974, { type: 'variable', doc: linkDoc({ 8978: linkUnit({ offset: 1 }), p: linkUnit() }) });
const control = wooProduct(1, { sku: 'rhymat-sync-control', status: 'private' });

test('load reads the shop once, keeps the link of each product and leaves out the control product', async () => {
  const { index, reads } = makeIndex([saumon, control, wooProduct(9, {})]);
  await index.load();
  assert.equal(reads.all, 1);
  assert.deepEqual(index.products().map((entry) => entry.product.id), [8974, 9]);
  assert.equal(index.lookup(8974, 8978).unit.offset, 1);
  assert.equal(index.lookup(8974, 0).kind, 'unit');
  assert.equal(index.lookup(9, 0).kind, 'none');
  assert.equal(index.lookup(404, 0).kind, 'none');
});

test('a unit that is not in the document, and a product without one, fall back to none', async () => {
  const { index } = makeIndex([saumon]);
  await index.load();
  assert.equal(index.lookup(8974, 7777).kind, 'none');
});

test('ignore and unreadable documents are reported as such', async () => {
  const ignore = wooProduct(10, { doc: linkDoc({}, { kind: 'ignore' }) });
  const newer = wooProduct(11, { docText: '{"schema":2}' });
  const { index } = makeIndex([ignore, newer]);
  await index.load();
  assert.equal(index.lookup(10, 0).kind, 'ignore');
  assert.deepEqual(index.lookup(11, 0), { kind: 'bad_doc', error: 'schema_unsupported' });
});

test('an unknown product is read on its own once, then served from the cache until it gets old', async () => {
  const { index, reads, clock } = makeIndex([saumon], { ttlMs: 1000 });
  assert.equal((await index.unitFor(8974, 8978)).kind, 'unit');
  assert.equal((await index.unitFor(8974, 8978)).kind, 'unit');
  assert.deepEqual(reads.one, ['8974']);
  clock.now = 1001;
  await index.unitFor(8974, 8978);
  assert.deepEqual(reads.one, ['8974', '8974']);
  assert.equal(reads.all, 0);
});

test('an order line without a product id needs no call', async () => {
  const { index, reads } = makeIndex([]);
  assert.equal((await index.unitFor(undefined, 0)).kind, 'none');
  assert.equal(reads.one.length, 0);
});

test('buildUnitLookup reads each line once and answers synchronously', async () => {
  const { index } = makeIndex([saumon]);
  const lookup = await buildUnitLookup([{ name: 'Saumon XS', quantity: 1, product_id: 8974, variation_id: 8978 }], index);
  assert.equal(lookup(8974, 8978).kind, 'unit');
});
