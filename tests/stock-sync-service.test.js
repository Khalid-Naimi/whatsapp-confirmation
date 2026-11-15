import test from 'node:test';
import assert from 'node:assert/strict';
import { LINK_META } from '../src/services/product-links.js';
import { MatchingWatch } from '../src/services/matching-watch.js';
import { FILLER, controlProduct, hdRows, linkDoc, linkUnit, makeService, makeShop, simpleProduct, wooProduct, wooVariation } from './helpers/fake-shop.js';

const FORBIDDEN_KEYS = /"(billing|shipping|phone|email|address\w*)":/u;

// Saumon hoodie (XS reads item 512, XL on hold), a cap capped at 6, and filler rows for the minimum item count.
function standardShop(extra = {}) {
  const saumon = wooProduct(8974, { type: 'variable', name: 'Hoodie Saumon', doc: linkDoc({ 8978: linkUnit({ label: '175cm <' }), 8975: linkUnit({ label: '190cm >', hold: true, items: [] }) }) });
  const cap = simpleProduct(8980, 24, { stock: 6, name: 'Cap', unit: { max_online: 6 } });
  return makeShop({
    products: [saumon, cap],
    variations: { 8974: [wooVariation(8978, '175cm <', { stock: 5 }), wooVariation(8975, '190cm >', { stock: 3 })] },
    hd: [...FILLER, ...hdRows([512, 2], [24, 20])],
    ...extra
  });
}

test('a dry run reads everything, writes no stock and only saves its own history', async () => {
  const shop = standardShop();
  const service = makeService(shop, { config: { mode: 'dry_run' } });
  const result = await service.run();
  assert.equal(result.mode.effective, 'dry_run');
  assert.equal(result.summary.mode, 'dry_run');
  assert.equal(result.summary.changed, 2); // XS 5 -> 2 and XL 3 -> 0 would change; the cap is already 6
  assert.equal(shop.stockWrites().length, 0);
  assert.equal(shop.stateWrites().length, 1);
  assert.deepEqual(shop.stateWrites()[0].fields.meta_data.map((row) => row.key), [LINK_META.state]);
  assert.equal(shop.products.find((p) => p.id === 8980).stock_quantity, 6);
});

test('a dry run asked for by the caller stays a dry run even when the mode is live', async () => {
  const shop = standardShop();
  const result = await makeService(shop).run({ dryRun: true });
  assert.equal(result.summary.mode, 'dry_run');
  assert.equal(shop.stockWrites().length, 0);
});

test('live: one batch per variable product with the audit meta, one update for a simple product', async () => {
  const shop = standardShop();
  const simple = simpleProduct(8990, 24, { stock: 0, name: 'Second cap' });
  shop.products.push(simple);
  const result = await makeService(shop).run();
  assert.equal(result.summary.changed, 3);
  const batch = shop.writes.filter((w) => w.kind === 'batch');
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0].updates.map((u) => [u.id, u.stock_quantity, u.stock_status, u.manage_stock]), [[8975, 0, 'outofstock', true], [8978, 2, 'instock', true]]);
  const xs = batch[0].updates.find((u) => u.id === 8978);
  const audit = JSON.parse(xs.meta_data[0].value);
  assert.equal(xs.meta_data[0].key, LINK_META.last);
  assert.deepEqual(audit, { at: '2026-11-15T10:00:00.000Z', cap: null, from: 5, hd: 2, hold: false, offset: 0, reserved: 0, run: result.summary.planHash.slice(0, 8), to: 2 });
  // the second cap shares item 24 (20 pieces) with the first cap, which already shows 6
  const single = shop.writes.find((w) => w.kind === 'product' && w.id === 8990);
  assert.deepEqual([single.fields.stock_quantity, single.fields.manage_stock, single.fields.backorders], [14, true, 'no']);
});

test('a second identical live run writes nothing', async () => {
  const shop = standardShop();
  const service = makeService(shop);
  await service.run();
  const stockWritesAfterFirst = shop.stockWrites().length;
  const second = await makeService(shop).run();
  assert.equal(second.summary.changed, 0);
  assert.equal(shop.stockWrites().length, stockWritesAfterFirst);
});

test('open orders keep their units reserved; an order already sent does not', async () => {
  const order = (state, status = 'processing') => ({ id: 1, status, line_items: [{ name: 'x', quantity: 1, product_id: 8974, variation_id: 8978 }], meta_data: state ? [{ key: 'rhymat_hd_api_state', value: state }] : [] });
  const shop = standardShop({ orders: [order(''), order('sending'), order('sent'), order('', 'completed')] });
  const result = await makeService(shop).run({ dryRun: true });
  const row = result.plan.find((r) => r.unit === '8978');
  assert.deepEqual([row.hd, row.reserved, row.target], [2, 2, 0]);
  assert.deepEqual(shop.calls.lastOrderQuery.statuses, ['processing', 'on-hold']);
  assert.equal(shop.calls.lastOrderQuery.after, undefined); // however old, an open order stays reserved
});

test('an order for a product that is only in the CSV still reserves its HighDelivery item', async () => {
  const productMap = (await import('../src/services/hd-product-match.js')).loadProductMap('woo_product_name,highdelivery_product_name\nOld hoodie,HD item 512\n');
  const shop = standardShop({ orders: [{ id: 2, status: 'on-hold', line_items: [{ name: 'Old hoodie', quantity: 1, product_id: 4242, variation_id: 0 }], meta_data: [] }] });
  const result = await makeService(shop, { productMap }).run({ dryRun: true });
  assert.equal(result.plan.find((r) => r.unit === '8978').reserved, 1);
});

test('too many changes stops the whole run; a wrong approval hash is refused, the right one applies once', async () => {
  const products = Array.from({ length: 12 }, (_, i) => simpleProduct(100 + i, 30 + i, { stock: 1 }));
  const shop = makeShop({ products, hd: [...FILLER, ...products.map((_, i) => hdRows([30 + i, 3])[0])] });
  const first = await makeService(shop).run();
  assert.equal(first.summary.aborted, 'too_many_changes');
  assert.equal(shop.stockWrites().length, 0);

  const wrong = await makeService(shop).run({ approveHash: 'f'.repeat(64) });
  assert.equal(wrong.approval, 'hash_mismatch');
  assert.equal(wrong.summary.aborted, 'too_many_changes');
  assert.equal(shop.stockWrites().length, 0);

  const approved = await makeService(shop).run({ approveHash: first.summary.planHash });
  assert.equal(approved.approval, 'applied');
  assert.equal(approved.summary.aborted, '');
  assert.equal(shop.stockWrites().length, 12);

  const again = await makeService(shop).run({ approveHash: first.summary.planHash });
  assert.equal(again.summary.changed, 0); // nothing left to apply, the old approval buys nothing
});

test('an approval never applies in a dry run', async () => {
  const products = Array.from({ length: 12 }, (_, i) => simpleProduct(100 + i, 30 + i, { stock: 1 }));
  const shop = makeShop({ products, hd: [...FILLER, ...products.map((_, i) => hdRows([30 + i, 3])[0])] });
  const first = await makeService(shop).run({ dryRun: true });
  const result = await makeService(shop).run({ dryRun: true, approveHash: first.summary.planHash });
  assert.equal(result.approval, 'not_live');
  assert.equal(shop.stockWrites().length, 0);
});

test('HighDelivery empty or total zero aborts and can never be approved', async () => {
  for (const hd of [[], hdRows([24, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0])]) {
    const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 4 })], hd });
    const first = await makeService(shop).run();
    assert.match(first.summary.aborted, /^hd_(empty|total_zero)$/u);
    const approved = await makeService(shop).run({ approveHash: first.summary.planHash });
    assert.equal(approved.approval, 'not_approvable');
    assert.equal(shop.stockWrites().length, 0);
    assert.equal(shop.products.find((p) => p.id === 100).stock_quantity, 4);
  }
});

test('HighDelivery, the order list or the product list failing aborts without any write', async () => {
  for (const [failOn, reason] of [[{ hd: true }, 'hd_unavailable'], [{ orders: true }, 'orders_failed'], [{ products: true }, 'woo_products_failed']]) {
    const shop = standardShop({ failOn });
    const result = await makeService(shop).run();
    assert.equal(result.summary.aborted, reason);
    assert.equal(shop.stockWrites().length, 0);
  }
});

test('a missing, paused or unreadable control record means no writes, but the plan is still computed', async () => {
  const cases = [
    { control: null },
    { control: controlProduct({ schema: 1, rev: 1, paused: true, ignored_hd_ids: [] }) },
    { control: controlProduct('{not json') },
    { failOn: { control: true } }
  ];
  for (const extra of cases) {
    const shop = standardShop(extra);
    const result = await makeService(shop).run();
    assert.equal(result.mode.paused, true);
    assert.equal(result.mode.effective, 'dry_run');
    assert.equal(result.summary.mode, 'dry_run');
    assert.ok(result.plan.length > 0);
    assert.equal(shop.stockWrites().length, 0);
  }
});

test('when the control record cannot be read at all the history is not overwritten', async () => {
  const shop = standardShop({ failOn: { control: true } });
  await makeService(shop).run();
  assert.equal(shop.stateWrites().length, 0);
});

test('a write that fails stops the run, nothing after it is attempted, and the report says what was written', async () => {
  const products = [simpleProduct(100, 24, { stock: 1 }), simpleProduct(101, 25, { stock: 1 }), simpleProduct(102, 26, { stock: 1 })];
  const shop = makeShop({ products, hd: [...FILLER, ...hdRows([24, 3], [25, 3], [26, 3])], failOn: { product: [101] } });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'write_failed');
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.changed, 1);
  assert.match(result.summary.abortDetail, /stopped after 1 of 3 units: product 101/u);
  assert.deepEqual(shop.stockWrites().map((w) => w.id), [100, 101]);
});

test('a variation the shop refuses inside a batch also stops the run and is named', async () => {
  const shop = standardShop({ failOn: { variation: [8975] } });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'write_failed');
  assert.match(result.summary.abortDetail, /variation 8975 of product 8974/u);
  assert.equal(result.summary.changed, 1);
});

test('one product whose variations cannot be read is skipped; more than three stop the run', async () => {
  const variable = (id) => wooProduct(id, { type: 'variable', doc: linkDoc({ [id + 1]: linkUnit({ items: [{ hd_id: id, hd_name: `HD item ${id}`, qty: 1 }] }) }) });
  const make = (failing) => {
    const products = [200, 300, 400, 500, 600].map(variable);
    return makeShop({ products, variations: Object.fromEntries(products.map((p) => [p.id, [wooVariation(p.id + 1, 'M', { stock: 0 })]])), hd: [...FILLER, ...products.map((p) => hdRows([p.id, 1])[0])], failOn: { variations: failing } });
  };
  const one = make([200]);
  const result = await makeService(one).run();
  assert.deepEqual([result.summary.errors, result.summary.aborted, result.summary.changed], [1, '', 4]);
  const many = make([200, 300, 400, 500]);
  const aborted = await makeService(many).run();
  assert.equal(aborted.summary.aborted, 'variations_failed');
  assert.equal(many.stockWrites().length, 0);
});

test('the hourly sync with the mode off makes no call at all; a dry run can still be asked for', async () => {
  const shop = standardShop();
  const service = makeService(shop, { config: { mode: 'off' } });
  assert.deepEqual((await service.run()).skipped, 'off');
  assert.equal(shop.writes.length, 0);
  assert.equal(shop.calls.orders, 0);
  const preview = await service.run({ dryRun: true });
  assert.equal(preview.summary.mode, 'dry_run');
  assert.equal(shop.stockWrites().length, 0);
});

test('with the mode off a manual preview saves nothing and sends no digest', async () => {
  const sent = [];
  const watch = new MatchingWatch({ notify: async (m) => { sent.push(m); return 2; }, enabled: true });
  const shop = standardShop();
  shop.products.push(wooProduct(555, { name: 'Brand new hoodie' }));
  const result = await makeService(shop, { config: { mode: 'off' }, matchingWatch: watch }).run({ dryRun: true });
  assert.ok(result.plan.length > 0);
  assert.equal(shop.writes.length, 0);
  assert.deepEqual(sent, []);
  // the same preview in dry_run mode does save its history and may send the digest
  await makeService(shop, { config: { mode: 'dry_run' }, matchingWatch: watch }).run({ dryRun: true });
  assert.equal(shop.stateWrites().length, 1);
  assert.equal(sent.length, 1);
});

test('two runs at the same time: the second says already_running', async () => {
  const shop = standardShop();
  const service = makeService(shop);
  const [first, second] = await Promise.all([service.run(), service.run()]);
  assert.equal(second.skipped, 'already_running');
  assert.ok(first.summary);
  assert.equal(service.running, false);
});

test('the run history survives a restart; only the newest run keeps its change list; 24 runs are kept', async () => {
  const shop = standardShop();
  for (let i = 0; i < 26; i += 1) {
    await makeService(shop, { now: new Date(NOW_MS + i * 3600000) }).run({ dryRun: true });
  }
  const state = shop.controlState();
  assert.equal(state.runs.length, 24);
  assert.ok(state.runs.at(-1).changes.length > 0);
  assert.ok(state.runs.slice(0, -1).every((run) => !('changes' in run)));
  const restarted = await makeService(shop).status();
  assert.equal(restarted.lastRun.at, state.runs.at(-1).at);
  assert.equal(restarted.plan.length, 0); // the plan itself is only kept in memory
});
const NOW_MS = Date.parse('2026-11-15T10:00:00Z');

test('a live abort tells the team once, and again only after six hours; a dry run stays quiet', async () => {
  const sent = [];
  const notify = async (message) => { sent.push(message); return 2; };
  const shop = makeShop({ products: [simpleProduct(100, 24, { stock: 4 })], hd: [] });
  const at = (hours) => new Date(NOW_MS + hours * 3600000);
  await makeService(shop, { notify, now: at(0) }).run();
  await makeService(shop, { notify, now: at(1) }).run();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Rhymat: synchro du stock arretee/u);
  await makeService(shop, { notify, now: at(7) }).run();
  assert.equal(sent.length, 2);

  const quiet = [];
  await makeService(shop, { config: { mode: 'dry_run' }, notify: async (m) => { quiet.push(m); return 2; }, now: at(30) }).run();
  assert.equal(quiet.length, 0);
});

test('status shows the mode and, after a run, the plan; it has no customer data', async () => {
  const order = { id: 7, status: 'processing', billing: { phone: '+212600000000', email: 'a@b.c' }, shipping: { address_1: 'Rue 1' }, line_items: [{ name: 'x', quantity: 1, product_id: 8974, variation_id: 8978 }], meta_data: [] };
  const shop = standardShop({ orders: [order] });
  const service = makeService(shop);
  await service.run({ dryRun: true });
  const status = await service.status();
  assert.deepEqual(status.mode, { env: 'live', paused: false, effective: 'live', controlProblem: '' });
  assert.equal(status.running, false);
  assert.ok(status.plan.length > 0);
  assert.doesNotMatch(JSON.stringify(status), FORBIDDEN_KEYS);
  assert.doesNotMatch(JSON.stringify(status), /Rue 1|a@b\.c|\+2126/u);
  assert.doesNotMatch(JSON.stringify((await service.run({ dryRun: true })).plan), FORBIDDEN_KEYS);
});

test('the unlinked products and HighDelivery items of the last run are reported', async () => {
  const shop = standardShop();
  shop.products.push(wooProduct(555, { name: 'Brand new hoodie' }));
  const service = makeService(shop);
  await service.run({ dryRun: true });
  const status = await service.status();
  assert.deepEqual(status.unlinked.woo, [{ productId: 555, unit: 'p', name: 'Brand new hoodie', productName: 'Brand new hoodie' }]);
  assert.equal(status.unlinked.hd.length, 5); // the five filler rows
  const snapshot = service.healthSnapshot();
  assert.deepEqual(snapshot.unlinked, { woo: 1, hd: 5, products: 1 });
});

test('a garbage HighDelivery quantity never reaches the shop: that unit is skipped and the others still sync', async () => {
  const products = [simpleProduct(100, 24, { stock: 1 }), ...[1, 2, 3, 4].map((n) => simpleProduct(100 + n, 30 + n, { stock: 1 }))];
  const hd = [...FILLER, { id: 24, name: 'bad', quantity_available: 'abc' }, ...[31, 32, 33, 34].map((id) => ({ id, name: `ok ${id}`, quantity_available: 6 }))];
  const shop = makeShop({ products, hd });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, '');
  assert.equal(result.plan.find((row) => row.productId === 100).action, 'skip_hd_bad');
  assert.equal(shop.stockWrites().length, 4);
  assert.ok(shop.stockWrites().every((write) => Number.isInteger(write.fields.stock_quantity)));
  assert.equal(shop.products.find((p) => p.id === 100).stock_quantity, 1);
});

test('when most HighDelivery quantities are garbage the whole run stops', async () => {
  const products = [1, 2].map((n) => simpleProduct(100 + n, 20 + n, { stock: 1 }));
  const hd = [...FILLER, { id: 21, name: 'a', quantity_available: 'x' }, { id: 22, name: 'b', quantity_available: 'y' }];
  const shop = makeShop({ products, hd });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'hd_ids_missing');
  assert.equal(shop.stockWrites().length, 0);
});

test('a unit made of two HighDelivery pieces shows half the pool, and an open order reserves both pieces', async () => {
  const pair = simpleProduct(100, 24, { stock: 9, unit: { items: [{ hd_id: 24, hd_name: 'HD item 24', qty: 2 }] } });
  const order = { id: 1, status: 'processing', line_items: [{ name: 'Pair', quantity: 1, product_id: 100, variation_id: 0 }], meta_data: [] };
  const hd = [...FILLER, ...hdRows([24, 10])];
  const free = await makeService(makeShop({ products: [pair], hd })).run({ dryRun: true });
  assert.deepEqual([free.plan[0].target, free.plan[0].why], [5, 'hd 10 - reserved 0 - offset 0 = 10 / 2 per piece = 5']);
  const shop = makeShop({ products: [pair], hd, orders: [order] });
  const reserved = await makeService(shop).run();
  assert.deepEqual([reserved.plan[0].reserved, reserved.plan[0].target], [2, 4]);
  assert.equal(shop.stockWrites()[0].fields.stock_quantity, 4);
});

test('a reserve status the shop rejects stops the run (its orders would be missing) and is reported', async () => {
  const withConfirmed = { config: { reserveStatuses: ['processing', 'on-hold', 'confirmed'] } };
  const shop = standardShop({ failOn: { rejectedStatuses: ['confirmed'] } });
  const result = await makeService(shop, withConfirmed).run();
  assert.equal(result.summary.aborted, 'reserve_status_rejected');
  assert.deepEqual(result.summary.skippedStatuses, ['confirmed']);
  assert.match(result.summary.abortDetail, /order status confirmed/u);
  assert.equal(shop.stockWrites().length, 0);
  const approved = await makeService(shop, withConfirmed).run({ approveHash: result.summary.planHash });
  assert.equal(approved.summary.aborted, 'reserve_status_rejected');
  assert.equal(shop.stockWrites().length, 0);
  // the default statuses do not include "confirmed", so a shop that rejects it does not stop the run
  const fine = await makeService(standardShop({ failOn: { rejectedStatuses: ['confirmed'] } })).run({ dryRun: true });
  assert.deepEqual([fine.summary.aborted, fine.summary.skippedStatuses], ['', []]);
});

// Lets a test change the shop after the run has started reading it.
function afterFirstProductRead(shop, change) {
  const original = shop.wooClient.listAllProducts;
  shop.wooClient.listAllProducts = async () => {
    const products = await original();
    change();
    return products;
  };
}

test('a pause set while the run is going cancels it before the first write', async () => {
  const shop = standardShop();
  afterFirstProductRead(shop, () => {
    shop.products[0].meta_data.find((meta) => meta.key === LINK_META.control).value = JSON.stringify({ schema: 1, rev: 2, paused: true, ignored_hd_ids: [] });
  });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'mode_changed');
  assert.equal(result.mode.paused, true);
  assert.equal(shop.stockWrites().length, 0);
});

test('a control record that becomes unreadable while the run is going also cancels it', async () => {
  const shop = standardShop();
  afterFirstProductRead(shop, () => { shop.products[0].meta_data.find((meta) => meta.key === LINK_META.control).value = '{broken'; });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, 'mode_changed');
  assert.equal(shop.stockWrites().length, 0);
});

test('a new order that takes a planned item while the run is going cancels it; an unrelated one does not', async () => {
  const lateOrder = (productId, variationId) => ({ id: 9, status: 'processing', line_items: [{ name: 'x', quantity: 1, product_id: productId, variation_id: variationId }], meta_data: [] });
  for (const [late, aborted, writes] of [[lateOrder(8974, 8978), 'orders_changed', 0], [lateOrder(8980, 0), 'orders_changed', 0], [lateOrder(4242, 0), '', 2]]) {
    const shop = standardShop();
    shop.products.push(simpleProduct(8990, 24, { stock: 0, name: 'Second cap' }));
    const original = shop.wooClient.listOpenOrdersLite;
    let reads = 0;
    shop.wooClient.listOpenOrdersLite = async (...args) => {
      const answer = await original(...args);
      reads += 1;
      return reads === 1 ? answer : { ...answer, orders: [...answer.orders, late] };
    };
    const result = await makeService(shop).run();
    assert.equal(result.summary.aborted, aborted, JSON.stringify(late.line_items));
    assert.equal(shop.stockWrites().length, writes);
  }
});

test('an order that is held (hold unit) and sent after the plan does not cancel the run', async () => {
  const shop = standardShop();
  const original = shop.wooClient.listOpenOrdersLite;
  let reads = 0;
  shop.wooClient.listOpenOrdersLite = async (...args) => {
    const answer = await original(...args);
    reads += 1;
    return reads === 1 ? answer : { ...answer, orders: [{ id: 9, status: 'processing', line_items: [{ name: 'x', quantity: 1, product_id: 8974, variation_id: 8975 }], meta_data: [] }] };
  };
  assert.equal((await makeService(shop).run()).summary.aborted, '');
});

test('a dry run does not look again: it writes nothing anyway', async () => {
  const shop = standardShop();
  await makeService(shop).run({ dryRun: true });
  assert.equal(shop.calls.orders, 1);
});

test('parent-managed variations are never written, and do not count as restocks', async () => {
  const doc = linkDoc(Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [100 + n, linkUnit()])));
  const hoodie = wooProduct(100, { type: 'variable', doc });
  const variations = [1, 2, 3, 4, 5, 6].map((n) => wooVariation(100 + n, `v${n}`, { manage: 'parent', stock: 0 }));
  const shop = makeShop({ products: [hoodie], variations: { 100: variations }, hd: [...FILLER, ...hdRows([512, 4])] });
  const result = await makeService(shop).run();
  assert.equal(result.summary.aborted, ''); // six restocks would have stopped the run
  assert.equal(result.summary.skipped, 6);
  assert.equal(shop.stockWrites().length, 0);
});
