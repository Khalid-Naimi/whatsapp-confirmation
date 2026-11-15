import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkGuards, computeReservations, computeStockPlan, computeTarget, describeMode, planHash } from '../src/services/stock-sync-service.js';
import { parseLinkDoc } from '../src/services/product-links.js';
import { hdRows, FILLER, STOCK_CONFIG } from './helpers/fake-shop.js';
import { linkDoc, linkUnit, wooProduct, wooVariation } from './helpers/link-fixtures.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/link-doc.json', import.meta.url), 'utf8'));
const limits = STOCK_CONFIG;

// [{ product, link }] the way the LinkIndex hands them over.
const entry = (product) => ({ product, link: parseLinkDoc(product.meta_data[0]?.value || '') });
const plan = (products, { variations = {}, warehouse = hdRows([512, 2], [24, 20]), reservations = new Map() } = {}) =>
  computeStockPlan({ products: products.map(entry), variationsByProduct: new Map(Object.entries(variations).map(([id, rows]) => [Number(id), rows])), warehouse, reservations });

test('computeTarget gives the shared fixture answers', () => {
  for (const { name, hd, reserved, unit, expected } of fixture.targets) {
    assert.equal(computeTarget(hd, reserved, unit), expected, name);
  }
});

test('computeStockPlan gives the shared fixture answers for the same units', () => {
  for (const { name, hd, reserved, unit, expected } of fixture.targets) {
    const product = wooProduct(5, { stock: 99, manage: true, doc: linkDoc({ p: { ...unit, writer: 'server' } }) });
    const [row] = plan([product], { warehouse: hdRows([512, hd]), reservations: new Map([[512, reserved]]) });
    assert.equal(row.target, expected, name);
  }
});

test('offset, cap 6 and hold: the Black Cap, the Burgundy and the Saumon examples', () => {
  const cap = wooProduct(8980, { stock: 3, manage: true, doc: linkDoc({ p: linkUnit({ max_online: 6, items: [{ hd_id: 24, hd_name: 'Cap', qty: 1 }] }) }) });
  const burgundy = wooProduct(8968, { type: 'variable', doc: linkDoc({ 8969: linkUnit({ hold: true, items: [] }) }) });
  const saumon = wooProduct(8974, { type: 'variable', doc: linkDoc({ 8978: linkUnit(), 8975: linkUnit({ hold: true, items: [] }) }) });
  const rows = plan([cap, burgundy, saumon], {
    variations: { 8968: [wooVariation(8969, 'M', { stock: 5 })], 8974: [wooVariation(8978, 'XS', { stock: 2 }), wooVariation(8975, 'XL', { stock: 1 })] }
  });
  const byUnit = Object.fromEntries(rows.map((row) => [row.unit, row]));
  assert.deepEqual([byUnit.p.target, byUnit.p.action, byUnit.p.why], [6, 'write', 'hd 20 - reserved 0 - offset 0 = 20, capped at 6']);
  assert.deepEqual([byUnit['8969'].target, byUnit['8969'].action], [0, 'write']);
  assert.deepEqual([byUnit['8978'].hdId, byUnit['8978'].target, byUnit['8978'].action], [512, 2, 'same']); // XS reads the XL item
  assert.deepEqual([byUnit['8975'].target, byUnit['8975'].action, byUnit['8975'].why], [0, 'write', 'on hold: online stock is 0']);
});

test('a unit already at its target with managed stock is "same"; unmanaged stock always needs a write', () => {
  const managed = wooProduct(1, { stock: 2, manage: true, doc: linkDoc({ p: linkUnit() }) });
  const unmanaged = wooProduct(2, { stock: 2, manage: false, doc: linkDoc({ p: linkUnit() }) });
  const rows = plan([managed, unmanaged]);
  assert.deepEqual(rows.map((row) => [row.action, row.current]), [['same', 2], ['write', null]]);
});

test('a shared HighDelivery item loses the reserved units on every variation that uses it', () => {
  const lmkhoukha = wooProduct(7, { type: 'variable', doc: linkDoc({ 71: linkUnit(), 72: linkUnit() }) });
  const rows = plan([lmkhoukha], {
    variations: { 7: [wooVariation(71, '190cm >', { stock: 9 }), wooVariation(72, '182cm - 190cm', { stock: 9 })] },
    reservations: new Map([[512, 1]])
  });
  assert.deepEqual(rows.map((row) => row.target), [1, 1]);
});

test('units the server must not write get a skip row and no target', () => {
  const doc = linkDoc({
    1: linkUnit({ writer: 'desktop' }),
    2: linkUnit({ sync: false }),
    3: linkUnit({ items: [{ hd_id: 512, hd_name: 'a', qty: 1 }, { hd_id: 24, hd_name: 'b', qty: 1 }] }),
    4: linkUnit({ items: [{ hd_id: 12345, hd_name: 'gone', qty: 1 }] })
  });
  const product = wooProduct(9, { type: 'variable', doc });
  const rows = plan([product], { variations: { 9: [1, 2, 3, 4].map((id) => wooVariation(id, `v${id}`, { stock: 1 })) } });
  assert.deepEqual(rows.map((row) => [row.unit, row.action, row.target]), [
    ['1', 'skip_writer_desktop', null], ['2', 'skip_no_sync', null], ['3', 'skip_bundle', null], ['4', 'skip_hd_missing', null]
  ]);
});

test('a missing variation, an unreadable document and a product without a document are not planned as writes', () => {
  const missing = wooProduct(9, { type: 'variable', doc: linkDoc({ 99: linkUnit() }) });
  const newer = wooProduct(10, { docText: '{"schema":2}' });
  const plain = wooProduct(11, {});
  const ignored = wooProduct(12, { doc: linkDoc({}, { kind: 'ignore' }) });
  const rows = plan([missing, newer, plain, ignored], { variations: { 9: [] } });
  assert.deepEqual(rows.map((row) => [row.productId, row.action]), [[10, 'skip_bad_doc']]);
});

test('reservations: open orders count unless already sent; sending and unknown count too', () => {
  const order = (state, items = [{ product_id: 1, quantity: 2 }]) => ({ status: 'processing', line_items: items, meta_data: state ? [{ key: 'rhymat_hd_api_state', value: state }] : [] });
  const resolveLines = (lines) => lines.map((line) => ({ hdId: 512, quantity: line.quantity }));
  const reserved = computeReservations([order(''), order('sending'), order('unknown'), order('failed'), order('sent')], resolveLines);
  assert.equal(reserved.get(512), 8);
  assert.equal(computeReservations([], resolveLines).size, 0);
});

test('the plan hash is stable under row order and changes with any write', () => {
  const rows = plan([wooProduct(1, { stock: 0, manage: true, doc: linkDoc({ p: linkUnit() }) }), wooProduct(2, { stock: 0, manage: true, doc: linkDoc({ p: linkUnit({ offset: 1 }) }) })]);
  assert.equal(planHash(rows), planHash([...rows].reverse()));
  assert.notEqual(planHash(rows), planHash(rows.slice(1)));
  assert.match(planHash(rows), /^[0-9a-f]{64}$/u);
});

// --- guards ---

const writeRow = (productId, current, target) => ({ productId, unit: 'p', hdId: 512, action: 'write', current, target });
const ok = (rows, warehouse = [...FILLER, ...hdRows([512, 5])]) => checkGuards(rows, { warehouse, limits });

test('guards: nothing to complain about gives ok', () => {
  assert.deepEqual(ok([writeRow(1, 1, 2)]), { ok: true, reason: '', detail: '', approvable: false });
});

test('guards: HighDelivery empty, all zero or too short can never be approved', () => {
  assert.deepEqual([ok([], []).reason, ok([], []).approvable], ['hd_empty', false]);
  const zeros = ok([writeRow(1, 1, 0)], hdRows([1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]));
  assert.deepEqual([zeros.reason, zeros.approvable], ['hd_total_zero', false]);
  const short = ok([], hdRows([1, 5], [2, 5], [3, 5], [4, 5]));
  assert.deepEqual([short.reason, short.approvable], ['hd_too_few_items', false]);
  assert.equal(ok([], hdRows([1, 5], [2, 5], [3, 5], [4, 5], [5, 5])).ok, true);
});

test('guards: more than 20 percent of the linked HighDelivery items missing stops the run', () => {
  const rows = (missing) => [1, 2, 3, 4, 5].map((id) => ({ productId: id, unit: 'p', hdId: id, action: id <= missing ? 'skip_hd_missing' : 'same', current: 1, target: 1 }));
  assert.equal(ok(rows(1)).ok, true);
  const two = ok(rows(2));
  assert.deepEqual([two.reason, two.approvable], ['hd_ids_missing', false]);
});

test('guards: size limits at their boundary values, and they can be approved', () => {
  const many = (count) => Array.from({ length: count }, (_, i) => writeRow(i + 1, 5, 6));
  assert.equal(ok(many(10)).ok, true);
  assert.deepEqual([ok(many(11)).reason, ok(many(11)).approvable], ['too_many_changes', true]);

  const delta = (count, step) => Array.from({ length: count }, (_, i) => writeRow(i + 1, 10, 10 + step));
  assert.equal(ok(delta(4, 10)).ok, true); // 40 in total
  assert.equal(ok(delta(1, 21)).reason, 'single_increase_too_big');
  assert.equal(ok(delta(3, 14)).reason, 'too_much_delta'); // 42 in total, each rise below 20

  const restocks = (count) => Array.from({ length: count }, (_, i) => writeRow(i + 1, 0, 1));
  assert.equal(ok(restocks(5)).ok, true);
  assert.deepEqual([ok(restocks(6)).reason, ok(restocks(6)).approvable], ['too_many_restocks', true]);
  assert.equal(ok([writeRow(1, 20, 40)]).ok, true); // a rise of exactly 20
  assert.equal(ok([writeRow(1, 20, 41)]).reason, 'single_increase_too_big');
});

test('guards: when a doubtful HighDelivery answer and a size limit fail together, the run cannot be approved', () => {
  const rows = Array.from({ length: 11 }, (_, i) => writeRow(i + 1, 5, 6));
  const result = ok(rows, hdRows([1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]));
  assert.deepEqual([result.reason, result.approvable], ['hd_total_zero', false]);
});

test('mode: live needs the env setting AND a readable control record that is not paused', () => {
  const read = (control) => ({ ok: control !== null, control, error: control ? '' : 'control_missing' });
  assert.equal(describeMode('live', read({ paused: false })).effective, 'live');
  assert.equal(describeMode('live', read({ paused: true })).effective, 'dry_run');
  assert.deepEqual(describeMode('live', read(null)), { env: 'live', paused: true, effective: 'dry_run', controlProblem: 'control_missing' });
  assert.equal(describeMode('dry_run', read({ paused: false })).effective, 'dry_run');
  assert.equal(describeMode('off', read({ paused: false })).effective, 'off');
});
