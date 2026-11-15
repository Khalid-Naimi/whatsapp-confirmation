import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { DURABLE_META, DurableState } from '../src/services/durable-state.js';
import { StockAlertService } from '../src/services/stock-alert-service.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { buildOptOutKeywords } from '../src/utils/opt-out.js';

const quiet = { log() {}, warn() {}, error() {} };

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'));
  return new JsonStore(path.join(dir, 'db.json'), { logger: quiet });
}

// The hidden control product as WooCommerce would hold it; updateProduct merges meta by key like the REST API.
function fakeShop({ product = { id: 77, sku: 'rhymat-sync-control', meta_data: [{ key: 'rhymat_sync_control', value: '{"schema":1,"paused":true}' }] } } = {}) {
  const shop = {
    product,
    failRead: false,
    failWrite: false,
    reads: 0,
    writes: [],
    async listProductsPage({ sku }) {
      shop.reads += 1;
      if (shop.failRead) {
        throw new Error('woo down');
      }
      return shop.product && shop.product.sku === sku ? [structuredClone(shop.product)] : [];
    },
    async updateProduct(id, { meta_data: meta }) {
      if (shop.failWrite) {
        throw new Error('woo write down');
      }
      shop.writes.push({ id, meta: structuredClone(meta) });
      for (const row of meta) {
        const existing = shop.product.meta_data.find((item) => item.key === row.key);
        if (existing) {
          existing.value = row.value;
        } else {
          shop.product.meta_data.push({ ...row });
        }
      }
      return shop.product;
    }
  };
  return shop;
}

const metaOf = (shop, key) => shop.product.meta_data.find((row) => row.key === key)?.value;
// verifySettleMs: 0 in these tests: the read-back after a save does not wait 1 s (the overlap test below sets it).

test('an opt-out survives a restart: saved to WooCommerce, loaded into a fresh local store before work', async () => {
  const shop = fakeShop();
  const first = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, store: freshStore(), logger: quiet });
  await first.load();
  assert.equal(await first.recordOptOut('+212600000101', '2026-11-15T10:00:00.000Z'), true);
  assert.deepEqual(JSON.parse(metaOf(shop, DURABLE_META.optOuts)), { schema: 1, phones: { '+212600000101': '2026-11-15' } });
  // The pause switch written by the desktop app is untouched.
  assert.equal(metaOf(shop, 'rhymat_sync_control'), '{"schema":1,"paused":true}');

  // "Restart": new process, empty disk.
  const store = freshStore();
  const second = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, store, logger: quiet });
  await second.load();
  assert.equal(second.isOptedOut('+212600000101'), true);
  assert.equal(store.isPhoneOptedOut('+212600000101'), true);
});

test('WooCommerce unreachable at boot: the service still starts, and the next write loads, merges and saves', async () => {
  const shop = fakeShop();
  shop.product.meta_data.push({ key: DURABLE_META.optOuts, value: '{"schema":1,"phones":{"+212600000001":"2026-10-01"}}' });
  shop.failRead = true;
  const warnings = [];
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, store: freshStore(), logger: { ...quiet, warn: (message) => warnings.push(message) } });
  const result = await state.load();
  assert.equal(result.ok, false);
  assert.ok(warnings.some((message) => message.includes('WARNING: could not read')));

  // Still down at the first opt-out: kept locally and marked for a retry, nothing overwritten.
  assert.equal(await state.recordOptOut('+212600000002'), false);
  assert.equal(shop.writes.length, 0);

  shop.failRead = false;
  assert.equal(await state.recordOptOut('+212600000003'), true);
  const phones = JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones;
  assert.deepEqual(Object.keys(phones).sort(), ['+212600000001', '+212600000002', '+212600000003']);
  assert.equal(state.loaded, true);
});

test('a missing control product is reported clearly and never blocks', async () => {
  const shop = fakeShop({ product: null });
  const warnings = [];
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: { ...quiet, warn: (message) => warnings.push(message) } });
  assert.equal((await state.load()).ok, false);
  assert.equal(state.status().error, 'control_missing');
  assert.ok(warnings.some((message) => message.includes('rhymat-sync-control')));
  assert.equal(await state.recordOptOut('+212600000009'), false);
  assert.equal(state.isOptedOut('+212600000009'), true);
});

test('WordPress opt-outs are merged in when WordPress is configured', async () => {
  const shop = fakeShop();
  const wordpressClient = {
    isConfigured: true,
    async getOptedOutContacts() {
      return { ok: true, data: { contacts: [{ phone: '+212600000201', optedOutAt: '2026-09-09T00:00:00Z' }, { phone: 'junk' }] } };
    }
  };
  const store = freshStore();
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, wordpressClient, store, logger: quiet });
  await state.load();
  assert.equal(state.isOptedOut('+212600000201'), true);
  assert.equal(store.isPhoneOptedOut('+212600000201'), true);
  assert.deepEqual(JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones, { '+212600000201': '2026-09-09' });
});

test('stock alert outcomes are bounded: old ones pruned, count capped, unsafe ids never stored', async () => {
  const shop = fakeShop();
  let nowMs = Date.parse('2026-11-15T00:00:00Z');
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet, limits: { stockAlerts: 3, stockAlertDays: 30 }, now: () => nowMs });
  await state.load();
  await state.recordStockAlert('old', 'sent');
  nowMs += 31 * 24 * 60 * 60 * 1000;
  for (const id of ['a1', 'a2', 'a3', 'a4']) {
    nowMs += 1000;
    await state.recordStockAlert(id, 'sent');
  }
  assert.equal(await state.recordStockAlert('bad"id', 'sent'), false);
  const stored = JSON.parse(metaOf(shop, DURABLE_META.stockAlerts)).alerts;
  assert.deepEqual(Object.keys(stored).sort(), ['a2', 'a3', 'a4']);
});

test('after a restart WordPress gets "sent" for an alert sent before it, and the alert is never sent twice', async () => {
  const shop = fakeShop();
  const sends = [];
  const wasenderClient = { async sendMessage(payload) { sends.push(payload); return { id: 'm' }; } };
  const alert = { id: 'sa-1', phone: '+212600000301', productName: 'Hoodie', size: 'M', productUrl: 'https://shop.example/p/1' };

  const firstState = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await firstState.load();
  const first = new StockAlertService({ store: freshStore(), wasenderClient, durableState: firstState, autoProcess: false, logger: quiet });
  first.accept([alert]);
  await first.processQueue();
  assert.equal(sends.length, 1);

  const secondState = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await secondState.load();
  const second = new StockAlertService({ store: freshStore(), wasenderClient, durableState: secondState, autoProcess: false, logger: quiet });
  assert.deepEqual(second.statuses(['sa-1', 'sa-2']), { 'sa-1': 'sent', 'sa-2': 'unknown' });
  const again = second.accept([alert]);
  assert.deepEqual(again.skipped, [{ id: 'sa-1', reason: 'already_handled' }]);
  await second.processQueue();
  assert.equal(sends.length, 1);
});

test('a durable opt-out blocks stock alerts even when the local cache was wiped', async () => {
  const shop = fakeShop();
  shop.product.meta_data.push({ key: DURABLE_META.optOuts, value: '{"schema":1,"phones":{"+212600000401":"2026-10-01"}}' });
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await state.load();
  const service = new StockAlertService({ store: freshStore(), wasenderClient: { async sendMessage() { throw new Error('must not send'); } }, durableState: state, autoProcess: false, logger: quiet });
  const result = service.accept([{ id: 'x1', phone: '+212600000401', productName: 'Tee', size: 'S', productUrl: 'https://shop.example/p/2' }]);
  assert.deepEqual(result.skipped, [{ id: 'x1', reason: 'opted_out' }]);
});

test('an inbound STOP is saved durably through the confirmation service', async () => {
  const shop = fakeShop();
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await state.load();
  const service = new ConfirmationService({
    store: freshStore(),
    wasenderClient: { async sendMessage() { return { id: 'x' }; } },
    wooClient: { async listOrdersByStatuses() { return []; }, async addOrderNote() { return {}; } },
    optOutKeywords: buildOptOutKeywords(''),
    durableState: state,
    messages: { defaultCityLabel: 'Maghrib' },
    logger: quiet
  });
  await service.handleOptOut({ senderPhone: '+212600000501', textBody: 'STOP', messageKey: 'k1', timestamp: '' });
  assert.ok(JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones['+212600000501']);
});

test('a change that arrives while a save is running is saved too (no lost write)', async () => {
  const shop = fakeShop();
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await state.load();
  const original = shop.updateProduct;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  shop.updateProduct = async (id, body) => {
    if (first) {
      first = false;
      await gate;
    }
    return original(id, body);
  };
  const a = state.recordOptOut('+212600000601');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Arrives while the first save is waiting on WooCommerce.
  state.optOuts.set('+212600000602', '2026-11-15');
  state.markDirty('optOuts');
  release();
  await a;
  await state.flush();
  const phones = JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones;
  assert.deepEqual(Object.keys(phones).sort(), ['+212600000601', '+212600000602']);
  assert.equal(state.status().pendingWrites.length, 0);
});

test('a stored value that cannot be read is never overwritten; the change stays in the local cache', async () => {
  const shop = fakeShop();
  shop.product.meta_data.push({ key: DURABLE_META.optOuts, value: '{"schema":9,"phones":{}}' });
  const warnings = [];
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: { ...quiet, warn: (message) => warnings.push(message) } });
  await state.load();
  assert.equal(await state.recordOptOut('+212600000701'), false);
  assert.equal(metaOf(shop, DURABLE_META.optOuts), '{"schema":9,"phones":{}}');
  assert.equal(state.isOptedOut('+212600000701'), true);
  assert.ok(warnings.some((message) => message.includes('cannot be read')));
  // The other record is still saved normally.
  assert.equal(await state.recordStockAlert('ok-1', 'sent'), true);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('two instances saving opt-outs at the same time: the one saved over notices it and saves again, nothing is lost', async () => {
  const shop = fakeShop();
  const a = new DurableState({ wooClient: shop, verifySettleMs: 30, logger: quiet });
  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  // Instance B talks to the same shop, but its save is slow: it lands after A's save.
  const bClient = {
    listProductsPage: (query) => shop.listProductsPage(query),
    async updateProduct(id, body) {
      await gateB;
      return shop.updateProduct(id, body);
    }
  };
  const warnings = [];
  const b = new DurableState({ wooClient: bClient, verifySettleMs: 30, logger: { ...quiet, warn: (message) => warnings.push(message) } });
  await a.load();
  await b.load();
  const savingB = b.recordOptOut('+212600000802'); // read the empty list; its save waits
  await pause(5);
  a.logger = { ...quiet, warn: (message) => warnings.push(message) };
  const savingA = a.recordOptOut('+212600000801'); // saved, now waiting to read it back
  await pause(5);
  releaseB(); // B saves its list (without A's opt-out) over A's
  assert.deepEqual(await Promise.all([savingA, savingB]), [true, true]);
  const phones = JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones;
  assert.deepEqual(Object.keys(phones).sort(), ['+212600000801', '+212600000802']);
  assert.ok(warnings.some((message) => message.includes('saved over by another writer')));
});

test('an opt-out that is saved over twice stays marked for the next write', async () => {
  const shop = fakeShop();
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await state.load();
  // Something keeps writing an empty list right after every save.
  const original = shop.updateProduct;
  shop.updateProduct = async (id, body) => {
    const result = await original(id, body);
    await original(id, { meta_data: [{ key: DURABLE_META.optOuts, value: '{"schema":1,"phones":{}}' }] });
    return result;
  };
  assert.equal(await state.recordOptOut('+212600000901'), false);
  assert.deepEqual(state.status().pendingWrites, ['optOuts']);
  shop.updateProduct = original;
  assert.equal(await state.recordOptOut('+212600000902'), true);
  assert.deepEqual(Object.keys(JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones).sort(), ['+212600000901', '+212600000902']);
});

test('a read-back served from before the save (stale cache, older than the save time) is read again after a moment, not re-written', async () => {
  const shop = fakeShop();
  shop.product.date_modified_gmt = '2026-11-15T10:00:00';
  const waits = [];
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 1000, sleep: async (ms) => { waits.push(ms); }, logger: quiet });
  await state.load();
  // The first read after each save still shows the old value (as a page cache would).
  const read = shop.listProductsPage;
  let staleBefore = null;
  shop.listProductsPage = async (query) => {
    const rows = await read(query);
    if (staleBefore) {
      const old = staleBefore;
      staleBefore = null;
      return [old];
    }
    return rows;
  };
  const write = shop.updateProduct;
  shop.updateProduct = async (id, body) => {
    staleBefore = structuredClone(shop.product);
    const result = await write(id, body);
    shop.product.date_modified_gmt = '2026-11-15T10:00:05';
    return { ...result, date_modified_gmt: '2026-11-15T10:00:05' };
  };
  assert.equal(await state.recordOptOut('+212600000911'), true);
  assert.deepEqual(waits, [1000]);
  assert.equal(shop.writes.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(metaOf(shop, DURABLE_META.optOuts)).phones), ['+212600000911']);
});

test('a stale read-back by modification time is told apart from an overwrite', async () => {
  const shop = fakeShop();
  shop.product.date_modified_gmt = '2026-11-15T10:00:00';
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await state.load();
  const write = shop.updateProduct;
  let reads = 0;
  shop.updateProduct = async (id, body) => {
    const before = structuredClone(shop.product);
    const result = await write(id, body);
    shop.product.date_modified_gmt = '2026-11-15T10:00:05';
    // Every read-back keeps serving the copy from before the save.
    const read = shop.listProductsPage;
    shop.listProductsPage = async () => { reads += 1; shop.listProductsPage = read; return [before]; };
    return { ...result, date_modified_gmt: '2026-11-15T10:00:05' };
  };
  assert.equal(await state.recordOptOut('+212600000912'), true);
  assert.equal(shop.writes.length, 1);
});

test('a missing control product sends ONE critical team alert, however often it is seen', async () => {
  const shop = fakeShop({ product: null });
  const sent = [];
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, alerts: { async alert(payload) { sent.push(payload); return { delivered: true }; } }, logger: quiet });
  await state.load();
  await state.recordOptOut('+212600000921');
  await state.recordOptOut('+212600000922');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].key, sent[0].level], ['durable_control_missing', 'critical']);
  assert.doesNotMatch(sent[0].text, /\+2126/u);
});

test('without a save time from WooCommerce a read-back that looks old is never called stale: it is merged and saved again', async () => {
  const shop = fakeShop();
  const state = new DurableState({ wooClient: shop, verifySettleMs: 0, staleRetryMs: 0, logger: quiet });
  await state.load();
  const read = shop.listProductsPage;
  let oldCopy = null;
  shop.listProductsPage = async (query) => {
    if (oldCopy) {
      const copy = oldCopy;
      oldCopy = null;
      return [copy];
    }
    return read(query);
  };
  const write = shop.updateProduct;
  shop.updateProduct = async (id, body) => {
    if (!shop.writes.length) {
      oldCopy = structuredClone(shop.product);
    }
    return write(id, body);
  };
  assert.equal(await state.recordOptOut('+212600000931'), true);
  assert.equal(shop.writes.length, 2);
});
