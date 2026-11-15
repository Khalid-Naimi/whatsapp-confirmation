import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncControl, fitState } from '../src/services/sync-control.js';
import { emptyState, parseState } from '../src/services/product-links.js';
import { controlProduct, makeShop } from './helpers/fake-shop.js';

test('read returns the pause switch and the saved history of the control product', async () => {
  const state = { ...emptyState(), runs: [{ at: 'x' }] };
  const shop = makeShop({ control: controlProduct({ schema: 1, rev: 2, paused: true, ignored_hd_ids: [5] }, state) });
  const read = await new SyncControl({ wooClient: shop.wooClient }).read();
  assert.deepEqual([read.ok, read.control.paused, read.control.ignored_hd_ids, read.state.runs.length, read.productId], [true, true, [5], 1, 1]);
});

test('a missing control product is not ok and has no product id; a failed read has none either', async () => {
  const missing = await new SyncControl({ wooClient: makeShop({ control: null }).wooClient }).read();
  assert.deepEqual([missing.ok, missing.error, missing.productId], [false, 'control_missing', null]);
  const failed = await new SyncControl({ wooClient: makeShop({ failOn: { control: true } }).wooClient }).read();
  assert.deepEqual([failed.ok, failed.error, failed.productId], [false, 'control_read_failed', null]);
});

test('saveState writes only the state meta of the control product, and cannot run before a read', async () => {
  const shop = makeShop();
  const control = new SyncControl({ wooClient: shop.wooClient });
  await assert.rejects(control.saveState(emptyState()), /not known yet/u);
  await control.read();
  await control.saveState({ ...emptyState(), runs: [{ at: 'y' }] });
  assert.equal(shop.writes.length, 1);
  assert.deepEqual(shop.writes[0].fields.meta_data.map((row) => row.key), ['rhymat_sync_state']);
  assert.equal(parseState(shop.writes[0].fields.meta_data[0].value).state.runs[0].at, 'y');
});

test('a state over 16 KB loses its oldest runs first and then its oldest alert marks', () => {
  const runs = Array.from({ length: 24 }, (_, i) => ({ at: `run-${i}`, pad: 'x'.repeat(1000) }));
  const fitted = fitState({ ...emptyState(), runs });
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 16 * 1024);
  assert.equal(fitted.runs.at(-1).at, 'run-23');
  assert.ok(fitted.runs.length < 24);

  const alerted = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [String(1000 + i), `2026-11-${String(10 + (i % 5)).padStart(2, '0')}T00:00:00Z`]));
  const trimmed = fitState({ ...emptyState(), alerted: { woo: alerted, hd: {} } });
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 16 * 1024);
  const left = Object.values(trimmed.alerted.woo);
  const count = (day) => left.filter((at) => at.startsWith(`2026-11-${day}`)).length;
  assert.ok(left.length > 0 && left.length < 800);
  assert.ok(count(10) <= count(14)); // the oldest marks went first
});
