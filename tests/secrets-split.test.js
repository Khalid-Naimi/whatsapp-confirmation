import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { secretMatchesAny, verifyWasenderSignature, verifyWooSignature } from '../src/utils/signatures.js';

const quiet = { log() {}, warn() {}, error() {} };

function makeHandler(tasks) {
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-')), 'db.json'), { logger: quiet });
  return createApp({
    config: { tasks },
    confirmationService: { async runOrderFollowups() { return {}; } },
    store,
    stockAlertService: { statuses: () => ({}), accept: () => ({ accepted: [], skipped: [] }) },
    logger: quiet
  });
}

function call(handler, method, url, secret) {
  return new Promise((resolve) => {
    const headers = secret === undefined ? {} : { 'x-task-secret': secret };
    const req = { method, url, headers, on(event, callback) { if (event === 'end') { setImmediate(callback); } return this; } };
    const res = { writeHead(status) { this.status = status; }, end() { resolve(this.status); } };
    handler(req, res);
  });
}

test('with API_READ_SECRET set, GET /api/* accept it or TASK_SECRET; /tasks/* accept TASK_SECRET only', async () => {
  const handler = makeHandler({ secret: 'task-secret', readSecret: 'read-secret' });
  assert.equal(await call(handler, 'GET', '/api/contacts/opted-out', 'read-secret'), 200);
  assert.equal(await call(handler, 'GET', '/api/contacts/opted-out', 'task-secret'), 200);
  assert.equal(await call(handler, 'GET', '/api/contacts/opted-out', 'wrong'), 401);
  assert.equal(await call(handler, 'GET', '/api/contacts/opted-out'), 401);
  assert.equal(await call(handler, 'GET', '/tasks/stock-alerts/status?ids=1', 'read-secret'), 401);
  assert.equal(await call(handler, 'GET', '/tasks/stock-alerts/status?ids=1', 'task-secret'), 200);
  assert.equal(await call(handler, 'POST', '/tasks/order-followups', 'read-secret'), 401);
  assert.equal(await call(handler, 'POST', '/tasks/order-followups', 'task-secret'), 200);
});

test('without API_READ_SECRET nothing changes', async () => {
  const handler = makeHandler({ secret: 'task-secret', readSecret: '' });
  assert.equal(await call(handler, 'GET', '/api/contacts/opted-out', 'task-secret'), 200);
  assert.equal(await call(handler, 'GET', '/api/contacts/opted-out', ''), 401);
  const closed = makeHandler({ secret: '', readSecret: '' });
  assert.equal(await call(closed, 'GET', '/api/contacts/opted-out', ''), 503);
  assert.equal(await call(closed, 'POST', '/tasks/order-followups', 'x'), 503);
});

test('one constant-time helper: any of several secrets, empty ones never match', () => {
  assert.equal(secretMatchesAny('b', ['a', 'b']), true);
  assert.equal(secretMatchesAny('c', ['a', 'b']), false);
  assert.equal(secretMatchesAny('', ['', 'a']), false);
  assert.equal(secretMatchesAny(undefined, ['a']), false);
  assert.equal(secretMatchesAny('a', []), false);
});

test('webhook signatures still verify through the same helper', () => {
  const body = '{"id":1}';
  const woo = crypto.createHmac('sha256', 'ws').update(body).digest('base64');
  assert.equal(verifyWooSignature(body, woo, 'ws'), true);
  assert.equal(verifyWooSignature(body, `${woo}x`, 'ws'), false);
  assert.equal(verifyWasenderSignature(body, 'plain-secret', 'plain-secret'), true);
  assert.equal(verifyWasenderSignature(body, crypto.createHmac('md5', 'plain-secret').update(body).digest('hex'), 'plain-secret'), true);
  assert.equal(verifyWasenderSignature(body, 'plain-secreT', 'plain-secret'), false);
});
