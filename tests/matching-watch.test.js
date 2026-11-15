import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchingWatch, buildDigest, findUnlinked } from '../src/services/matching-watch.js';
import { parseLinkDoc } from '../src/services/product-links.js';
import { FILLER, controlProduct, hdRows, makeService, makeShop, simpleProduct } from './helpers/fake-shop.js';
import { linkDoc, linkUnit, wooProduct, wooVariation } from './helpers/link-fixtures.js';

const entry = (product) => ({ product, link: parseLinkDoc(product.meta_data[0]?.value || '') });
const find = (products, { variations = {}, warehouse = [], control = null } = {}) =>
  findUnlinked({ products: products.map(entry), variationsByProduct: new Map(Object.entries(variations).map(([id, rows]) => [Number(id), rows])), warehouse, control });

test('a published product without a document is listed per size; drafts and ignored products are not', () => {
  const wavy = wooProduct(9012, { type: 'variable', name: 'Hoodie Wavy 23' });
  const draft = wooProduct(9013, { status: 'draft', name: 'Draft' });
  const gift = wooProduct(9014, { doc: linkDoc({}, { kind: 'ignore' }), name: 'Gift card' });
  const result = find([wavy, draft, gift], { variations: { 9012: [wooVariation(1, '170cm <'), wooVariation(2, '175cm'), wooVariation(3, 'hidden', { status: 'private' })] } });
  assert.deepEqual(result.woo, [
    { productId: 9012, unit: '1', name: 'Hoodie Wavy 23 - 170cm <', productName: 'Hoodie Wavy 23' },
    { productId: 9012, unit: '2', name: 'Hoodie Wavy 23 - 175cm', productName: 'Hoodie Wavy 23' }
  ]);
});

test('a variation missing from the document is unlinked; a document unit without a variation is a broken link', () => {
  const hoodie = wooProduct(8974, { type: 'variable', name: 'Saumon', doc: linkDoc({ 8978: linkUnit(), 7777: linkUnit() }) });
  const result = find([hoodie], { variations: { 8974: [wooVariation(8978, 'XS'), wooVariation(8979, 'S')] } });
  assert.deepEqual(result.woo.map((row) => row.unit), ['8979']);
  assert.deepEqual(result.broken, [{ productId: 8974, unit: '7777', problem: 'variation_missing' }]);
});

test('a variable product whose variations could not be read is neither unlinked nor broken', () => {
  const hoodie = wooProduct(8974, { type: 'variable', doc: linkDoc({ 8978: linkUnit() }) });
  const result = find([hoodie]);
  assert.deepEqual([result.woo, result.broken], [[], []]);
});

test('an unreadable document is reported as a bad document, not as unlinked', () => {
  const result = find([wooProduct(10, { docText: '{"schema":2}' }), wooProduct(11, { docText: '{oops' })]);
  assert.deepEqual(result.badDocs.map((row) => [row.productId, row.error]), [[10, 'schema_unsupported'], [11, 'not_json']]);
  assert.deepEqual(result.woo, []);
});

test('HighDelivery items not used by any document and not ignored are listed', () => {
  const linked = simpleProduct(1, 512);
  const warehouse = hdRows([512, 2], [540, 12, 'Hoodie Wavy 23 Black M'], [77, 1], [81, 1]);
  const result = find([linked], { warehouse, control: { ignored_hd_ids: [77, 81] } });
  assert.deepEqual(result.hd, [{ id: 540, name: 'Hoodie Wavy 23 Black M', quantity: 12 }]);
});

// --- the digest ---

test('the digest names products and items only, counts sizes, and shortens long lists', () => {
  const woo = [1, 2, 3, 4].map((n) => ({ productId: 9012, unit: String(n), name: 'x', productName: 'Hoodie Wavy 23' }));
  const hd = Array.from({ length: 7 }, (_, i) => ({ id: i, name: `Item ${i}`, quantity: 1 }));
  const text = buildDigest({ woo, hd });
  assert.match(text, /^Rhymat: 8 nouveaux produits a relier\. Woo: Hoodie Wavy 23 \(4 tailles\)\. HD: Item 0, Item 1, Item 2, Item 3, Item 4 \(\+2 autres\)\. Ouvrir Matching dans l'app\.$/u);
  assert.equal(buildDigest({ woo: [], hd: [{ id: 1, name: 'Solo', quantity: 0 }] }), "Rhymat: 1 nouveau produit a relier. HD: Solo. Ouvrir Matching dans l'app.");
  assert.equal(buildDigest({ woo: [{ productId: 5, unit: 'p', name: 'Cap', productName: 'Cap' }], hd: [] }), "Rhymat: 1 nouveau produit a relier. Woo: Cap. Ouvrir Matching dans l'app.");
});

// --- the watch ---

const unlinkedOne = () => ({ woo: [{ productId: 9012, unit: '1', name: 'Wavy - 170', productName: 'Wavy' }], hd: [{ id: 540, name: 'Wavy Black M', quantity: 3 }], broken: [], badDocs: [] });
const emptyAlerted = () => ({ woo: {}, hd: {} });
const at = (hours) => new Date(Date.parse('2026-11-15T10:00:00Z') + hours * 3600000);

test('off by default: nothing is sent and the marks stay as they were', async () => {
  const sent = [];
  const watch = new MatchingWatch({ notify: async (m) => { sent.push(m); return 2; }, now: () => at(0) });
  const alerted = emptyAlerted();
  assert.equal(await watch.alertNew({ unlinked: unlinkedOne(), alerted }), alerted);
  assert.equal(sent.length, 0);
});

test('a new item is told once, not again within seven days, and again after seven days', async () => {
  const sent = [];
  const notify = async (m) => { sent.push(m); return 2; };
  let alerted = emptyAlerted();
  for (const hours of [0, 1, 24 * 6]) {
    alerted = await new MatchingWatch({ notify, enabled: true, now: () => at(hours) }).alertNew({ unlinked: unlinkedOne(), alerted });
  }
  assert.equal(sent.length, 1);
  assert.deepEqual(alerted, { woo: { 1: at(0).toISOString() }, hd: { 540: at(0).toISOString() } });
  alerted = await new MatchingWatch({ notify, enabled: true, now: () => at(24 * 7) }).alertNew({ unlinked: unlinkedOne(), alerted });
  assert.equal(sent.length, 2);
});

test('only the new items are in a later digest, and marks of linked items disappear', async () => {
  const sent = [];
  const watch = new MatchingWatch({ notify: async (m) => { sent.push(m); return 1; }, enabled: true, now: () => at(2) });
  const alerted = { woo: { 1: at(0).toISOString(), 99: at(0).toISOString() }, hd: {} };
  const next = await watch.alertNew({ unlinked: { ...unlinkedOne(), woo: [...unlinkedOne().woo] }, alerted });
  assert.match(sent[0], /nouveau produit a relier\. HD: Wavy Black M\./u);
  assert.deepEqual(Object.keys(next.woo), ['1']);
});

test('if nobody got the digest it is tried again at the next run', async () => {
  const watch = new MatchingWatch({ notify: async () => 0, enabled: true, logger: { warn() {} }, now: () => at(0) });
  assert.deepEqual(await watch.alertNew({ unlinked: unlinkedOne(), alerted: emptyAlerted() }), emptyAlerted());
});

test('end to end: one digest per new product, none after a restart, and no customer data in it', async () => {
  const sent = [];
  const notify = async (m) => { sent.push(m); return 2; };
  const order = { id: 1, status: 'processing', billing: { first_name: 'Jane', phone: '+212600000000' }, line_items: [], meta_data: [] };
  const shop = makeShop({ products: [simpleProduct(8980, 24, { stock: 6 }), wooProduct(555, { name: 'Brand new hoodie' })], hd: [...FILLER, ...hdRows([24, 20])], orders: [order] });
  const watch = (hours) => new MatchingWatch({ notify, enabled: true, now: () => at(hours) });
  await makeService(shop, { matchingWatch: watch(0), now: at(0) }).run({ dryRun: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Woo: Brand new hoodie\./u);
  assert.doesNotMatch(sent[0], /Jane|2126/u);
  await makeService(shop, { matchingWatch: watch(1), now: at(1) }).run({ dryRun: true }); // a new process: state comes back from the fake Woo
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(shop.controlState().alerted.woo), ['555']);
});

test('a control record that says an HD item is ignored keeps it out of the digest', async () => {
  const sent = [];
  const control = controlProduct({ schema: 1, rev: 1, paused: false, ignored_hd_ids: [901, 902, 903, 904, 905] });
  const shop = makeShop({ products: [], control, hd: FILLER });
  await makeService(shop, { matchingWatch: new MatchingWatch({ notify: async (m) => { sent.push(m); return 1; }, enabled: true, now: () => at(0) }), now: at(0) }).run({ dryRun: true });
  assert.equal(sent.length, 0);
});
