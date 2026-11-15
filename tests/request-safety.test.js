import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';

const quiet = { log() {}, warn() {}, error() {} };
const fullConfig = {
  tasks: { secret: 'task-secret' },
  woo: { webhookSecret: 'woo-secret' },
  wasender: { webhookSecret: 'wa-secret', signatureHeader: 'x-webhook-signature' }
};

function freshStore() {
  return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'req-safety-')), 'db.json'), { logger: quiet });
}

function call(app, { method = 'POST', url, headers = {}, body = '' }) {
  return new Promise((resolve) => {
    const listeners = {};
    let destroyed = false;
    const req = {
      method,
      url,
      headers,
      on(event, callback) {
        listeners[event] = callback;
        if (event === 'end') {
          setImmediate(() => {
            const text = String(body);
            for (let offset = 0; offset < text.length && !destroyed; offset += 64 * 1024) {
              listeners.data?.(Buffer.from(text.slice(offset, offset + 64 * 1024)));
            }
            listeners.end?.();
          });
        }
      },
      destroy() {
        destroyed = true;
      }
    };
    const res = {
      statusCode: 0,
      body: '',
      writeHead(code) { this.statusCode = code; },
      end(text) {
        this.body = text;
        setTimeout(() => resolve({ statusCode: this.statusCode, body: text ? JSON.parse(text) : null, destroyed }), 5);
      }
    };
    app(req, res);
  });
}

test('a body over 1 MB is refused with 413 and the request is dropped', async () => {
  const app = createApp({ config: fullConfig, confirmationService: {}, store: freshStore(), logger: quiet });
  const big = 'a'.repeat(1024 * 1024 + 10);
  const streamed = await call(app, { url: '/webhooks/woocommerce', body: big });
  assert.equal(streamed.statusCode, 413);
  assert.equal(streamed.destroyed, true);
  const declared = await call(app, { url: '/webhooks/woocommerce', headers: { 'content-length': String(5 * 1024 * 1024) } });
  assert.equal(declared.statusCode, 413);
});

test('without secrets configured every protected route answers 503 and nothing is processed', async () => {
  const processed = [];
  const confirmationService = {
    async processWooOrder() { processed.push('woo'); return { status: 200, body: { ok: true } }; },
    async processWasenderInbound() { processed.push('wa'); return { status: 200, body: { ok: true } }; },
    async runOrderFollowups() { processed.push('followups'); return {}; }
  };
  const app = createApp({ config: { tasks: {}, woo: {}, wasender: { signatureHeader: 'x-webhook-signature' } }, confirmationService, store: freshStore(), logger: quiet });
  assert.equal((await call(app, { url: '/webhooks/woocommerce', body: '{"id":1}' })).statusCode, 503);
  assert.equal((await call(app, { url: '/webhooks/wasender', body: '{"id":1}' })).statusCode, 503);
  assert.equal((await call(app, { url: '/tasks/order-followups', headers: { 'x-task-secret': '' } })).statusCode, 503);
  assert.equal((await call(app, { method: 'GET', url: '/api/orders' })).statusCode, 503);
  assert.deepEqual(processed, []);
});

test('a valid WooCommerce delivery gets 200 even when processing throws', async () => {
  const confirmationService = { async processWooOrder() { throw new Error('disk full'); } };
  const app = createApp({ config: fullConfig, confirmationService, store: freshStore(), logger: quiet });
  const body = JSON.stringify({ id: 5, status: 'processing' });
  const signature = createHmac('sha256', 'woo-secret').update(body).digest('base64');
  const result = await call(app, { url: '/webhooks/woocommerce', headers: { 'x-wc-webhook-signature': signature }, body });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: false, reason: 'processing_failed' });
});

test('the hourly steps run independently: a follow-ups failure still runs the HighDelivery sync and the stock alerts', async () => {
  const ran = [];
  const confirmationService = { async runOrderFollowups() { ran.push('followups'); throw new Error('woo 503'); } };
  const hdStatusSyncService = { async run() { ran.push('hd'); throw new Error('hd down'); } };
  const stockAlertService = { async processQueue() { ran.push('alerts'); } };
  const durableState = { async ensureLoaded() { ran.push('durable'); return true; } };
  const app = createApp({ config: fullConfig, confirmationService, hdStatusSyncService, stockAlertService, durableState, store: freshStore(), logger: quiet });
  const result = await call(app, { url: '/tasks/order-followups', headers: { 'x-task-secret': 'task-secret' } });
  assert.equal(result.statusCode, 500);
  assert.deepEqual(ran, ['durable', 'followups', 'hd', 'alerts']);
  // The lock is released: the next run starts.
  const again = await call(app, { url: '/tasks/order-followups', headers: { 'x-task-secret': 'task-secret' } });
  assert.equal(again.statusCode, 500);
  assert.equal(ran.filter((step) => step === 'followups').length, 2);
});
