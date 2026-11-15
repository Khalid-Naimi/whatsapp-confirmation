import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { SHUTDOWN_GRACE_MS, createShutdown, shutdownWork } from '../src/lifecycle.js';

const quiet = { log() {}, warn() {}, error() {} };

test('the grace time is 25 seconds', () => {
  assert.equal(SHUTDOWN_GRACE_MS, 25000);
});

test('shutdown flushes due confirmations, then waits for drain, the stock sync and the durable writes, then runs the final steps', async () => {
  const order = [];
  let finishSync;
  const confirmationService = {
    async flushDueConfirmations() { order.push('flush'); },
    async drain() { await new Promise((resolve) => setTimeout(resolve, 5)); order.push('drain'); },
    async drainBackgroundTasks() { order.push('drainBackgroundTasks'); }
  };
  const stockSyncService = { runPromise: new Promise((resolve) => { finishSync = () => { order.push('sync'); resolve(); }; }) };
  const durableState = { get chain() { order.push('durable'); return Promise.resolve(); } };
  const exits = [];
  const shutdown = createShutdown({
    server: null,
    waitFor: shutdownWork({ confirmationService, stockSyncService, stockAlertService: { processing: null }, durableState }),
    finally: [() => order.push('store-flush')],
    graceMs: 1000,
    logger: quiet,
    exit: (code) => exits.push(code)
  });
  const done = shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, []);
  finishSync();
  await done;
  assert.equal(order[0], 'flush');
  assert.ok(order.indexOf('drain') < order.indexOf('store-flush'));
  assert.ok(order.includes('drainBackgroundTasks'));
  assert.ok(order.indexOf('drain') < order.indexOf('durable'));
  assert.ok(order.includes('sync'));
  assert.equal(order.at(-1), 'store-flush');
  assert.deepEqual(exits, [0]);
});

test('services without the new methods are skipped, and a failing flush does not stop the shutdown', async () => {
  const exits = [];
  const shutdown = createShutdown({
    server: null,
    waitFor: shutdownWork({ confirmationService: { async flushDueConfirmations() { throw new Error('wasender down'); } }, stockSyncService: { runPromise: null } }),
    finally: [() => { throw new Error('disk full'); }],
    graceMs: 200,
    logger: quiet,
    exit: (code) => exits.push(code)
  });
  await shutdown('SIGTERM');
  assert.deepEqual(exits, [0]);
  const bare = createShutdown({ server: null, waitFor: shutdownWork({}), graceMs: 50, logger: quiet, exit: (code) => exits.push(code) });
  await bare('SIGTERM');
  assert.deepEqual(exits, [0, 0]);
});

test('the stock sync tracks the promise of the run in progress', async () => {
  const { StockSyncService } = await import('../src/services/stock-sync-service.js');
  const service = Object.create(StockSyncService.prototype);
  Object.assign(service, { running: false, runPromise: null, config: { mode: 'dry_run' } });
  let release;
  service.execute = () => new Promise((resolve) => { release = () => resolve({ summary: {} }); });
  const run = service.run();
  assert.ok(service.runPromise instanceof Promise);
  release();
  await run;
  assert.equal(service.runPromise, null);
});

function postWasender(handler, body) {
  const raw = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: '/webhooks/wasender',
      headers: { 'x-webhook-signature': 'wsecret', 'content-length': String(raw.length) },
      on(event, callback) {
        if (event === 'data') { setImmediate(() => callback(Buffer.from(raw))); }
        if (event === 'end') { setImmediate(() => setImmediate(callback)); }
        return this;
      }
    };
    const res = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handler(req, res);
  });
}

test('a verified Wasender delivery is answered 200 even when processing throws', async () => {
  const lines = [];
  const handler = createApp({
    config: { wasender: { webhookSecret: 'wsecret', signatureHeader: 'x-webhook-signature' }, tasks: { secret: 't' } },
    confirmationService: { async processWasenderInbound() { throw new Error('Woo down for +212612345678'); } },
    store: new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-route-')), 'db.json'), { logger: quiet }),
    logger: { log() {}, warn() {}, error: (m) => lines.push(String(m)) }
  });
  const response = await postWasender(handler, { event: 'messages.upsert', data: {} });
  assert.deepEqual(response, { status: 200, body: { ok: false, reason: 'processing_failed' } });
  assert.ok(lines.some((line) => line.includes('processing failed')));
  assert.doesNotMatch(lines.join('\n'), /612345678/u);
});
