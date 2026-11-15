import test from 'node:test';
import assert from 'node:assert/strict';
import { WooCommerceClient } from '../src/services/woocommerce-client.js';

const LINK_JSON = '{"schema":1,"units":{"8978":{"label":"175cm <"}}}';

function makeClient(responses, { logs = [] } = {}) {
  const calls = [];
  const sleeps = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://shop.example',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    sleepImpl: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }
      const { status = 200, body = [] } = next || {};
      return { ok: status < 400, status, async text() { return JSON.stringify(body); } };
    }
  });
  return { client, calls, sleeps, logs };
}

const rows = (count, start = 1) => Array.from({ length: count }, (_, i) => ({ id: start + i }));

test('listAllProducts reads pages until a short page and asks for meta fields only', async () => {
  const { client, calls } = makeClient([{ body: rows(100) }, { body: rows(100, 101) }, { body: rows(7, 201) }]);
  const products = await client.listAllProducts();
  assert.equal(products.length, 207);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('page')), ['1', '2', '3']);
  assert.equal(calls[0].url.searchParams.get('status'), 'any');
  assert.match(calls[0].url.searchParams.get('_fields'), /meta_data/u);
});

test('listAllProducts stops after one page when the first page is short', async () => {
  const { client, calls } = makeClient([{ body: rows(3) }]);
  assert.equal((await client.listAllProducts()).length, 3);
  assert.equal(calls.length, 1);
});

test('a product list longer than 20 pages is an error, not an endless loop', async () => {
  const { client, calls } = makeClient(Array.from({ length: 25 }, () => ({ body: rows(100) })));
  await assert.rejects(client.listAllProducts(), /longer than 20 pages/u);
  assert.equal(calls.length, 20);
});

test('listVariations pages through one product and getProduct reads one', async () => {
  const { client, calls } = makeClient([{ body: rows(100) }, { body: rows(2, 101) }, { body: { id: 5 } }]);
  assert.equal((await client.listVariations(8974)).length, 102);
  assert.match(calls[0].url.pathname, /\/products\/8974\/variations$/u);
  assert.deepEqual(await client.getProduct(5, { fields: 'id,meta_data' }), { id: 5 });
  assert.equal(calls[2].url.searchParams.get('_fields'), 'id,meta_data');
});

test('listProductsPage can look a product up by SKU', async () => {
  const { client, calls } = makeClient([{ body: [] }]);
  await client.listProductsPage({ sku: 'rhymat-sync-control', perPage: 1 });
  assert.equal(calls[0].url.searchParams.get('sku'), 'rhymat-sync-control');
  assert.equal(calls[0].url.searchParams.get('per_page'), '1');
});

test('open orders are listed with a small field list, never the whole order', async () => {
  const { client, calls } = makeClient([{ body: [{ id: 1 }] }, { body: [] }]);
  const { orders, skippedStatuses } = await client.listOpenOrdersLite(['processing', 'on-hold'], { after: '2026-10-01T00:00:00Z' });
  assert.deepEqual([orders, skippedStatuses], [[{ id: 1 }], []]);
  assert.equal(calls[0].url.searchParams.get('_fields'), 'id,status,date_created_gmt,line_items,meta_data');
  assert.equal(calls[0].url.searchParams.get('after'), '2026-10-01T00:00:00Z');
  assert.equal(calls[1].url.searchParams.get('status'), 'on-hold');
});

test('listOrders without a field list keeps asking for whole orders', async () => {
  const { client, calls } = makeClient([{ body: [] }]);
  await client.listOrders({ status: 'processing' });
  assert.equal(calls[0].url.searchParams.has('_fields'), false);
});

test('updateProduct and batchUpdateVariations send the body and may be retried', async () => {
  const { client, calls, sleeps } = makeClient([
    { status: 502, body: { message: 'bad gateway' } },
    { body: { id: 5 } },
    { status: 503, body: {} },
    { status: 503, body: {} },
    { body: { update: [{ id: 1 }] } }
  ]);
  await client.updateProduct(5, { stock_quantity: 2 });
  await client.batchUpdateVariations(5, [{ id: 1, stock_quantity: 2 }]);
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'PUT', 'POST', 'POST', 'POST']);
  assert.match(calls[4].url.pathname, /\/products\/5\/variations\/batch$/u);
  assert.deepEqual(calls[4].body, { update: [{ id: 1, stock_quantity: 2 }] });
  // Backoff with jitter (behaviour change): about 1 s, then about 1 s and 2 s, each +-25 %.
  assert.equal(sleeps.length, 3);
  [1000, 1000, 2000].forEach((base, index) => assert.ok(sleeps[index] >= base * 0.75 && sleeps[index] <= base * 1.25, `sleep ${index}`));
});

test('a batch of more than 100 updates is refused before any call', async () => {
  const { client, calls } = makeClient([]);
  await assert.rejects(client.batchUpdateVariations(5, rows(101)), /at most 100/u);
  assert.equal(calls.length, 0);
});

// Behaviour change (backend hardening): every GET is retried now, the order lists too.
test('every GET is retried on a 5xx, the order lists and the product reads alike', async () => {
  const plain = makeClient([{ status: 500, body: {} }, { body: [] }]);
  assert.deepEqual(await plain.client.listOrders({ status: 'processing' }), []);
  assert.equal(plain.calls.length, 2);

  const reads = makeClient([{ status: 500, body: {} }, { body: [{ id: 1 }] }]);
  assert.deepEqual(await reads.client.listProductsPage(), [{ id: 1 }]);
  assert.equal(reads.calls.length, 2);
  assert.equal(reads.sleeps.length, 1);
});

test('three transient failures in a row give up with the last error', async () => {
  const { client, calls } = makeClient([{ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }, { body: [] }]);
  await assert.rejects(client.listProductsPage(), /failed with 500/u);
  assert.equal(calls.length, 3);
});

test('a refusal such as 400 is not retried even for idempotent calls', async () => {
  const { client, calls } = makeClient([{ status: 400, body: { code: 'bad' } }, { body: {} }]);
  await assert.rejects(client.updateProduct(5, {}), /failed with 400/u);
  assert.equal(calls.length, 1);
});

test('request logs name the meta keys of a write but never the link JSON', async () => {
  const logs = [];
  const { client } = makeClient([{ body: { id: 5, status: 'publish', meta_data: [{ key: 'rhymat_hd_link', value: LINK_JSON }] } }], { logs });
  await client.updateProduct(5, { meta_data: [{ key: 'rhymat_hd_link', value: LINK_JSON }] });
  const text = logs.join('\n');
  assert.match(text, /metaKeys=rhymat_hd_link/u);
  assert.doesNotMatch(text, /schema|175cm/u);
});

test('a failure reply that echoes the meta does not put the JSON in the log or the error', async () => {
  const logs = [];
  const echo = { code: 'bad', data: { meta_data: [{ id: 1, key: 'rhymat_hd_link', value: LINK_JSON.replaceAll('"', '\\"') }] } };
  const { client } = makeClient([{ status: 400, body: echo }], { logs });
  await assert.rejects(client.updateProduct(5, {}), (error) => {
    assert.doesNotMatch(error.message, /175cm/u);
    return true;
  });
  assert.doesNotMatch(logs.join('\n'), /175cm/u);
});

test('a status the shop rejects is skipped in the open order list, and the answer says so', async () => {
  const { client } = makeClient([{ body: [{ id: 1 }] }, { body: [] }, { status: 400, body: { code: 'rest_invalid_param' } }]);
  const { orders, skippedStatuses } = await client.listOpenOrdersLite(['processing', 'on-hold', 'confirmed']);
  assert.deepEqual([orders.length, skippedStatuses], [1, ['confirmed']]);
});
