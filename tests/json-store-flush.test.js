import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-flush-'));
  return { dir, file: path.join(dir, 'db.json') };
}
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the first change is written at once, a burst within the second is written together a moment later', async () => {
  const { file } = tempFile();
  const store = new JsonStore(file, { logger: quiet, flushIntervalMs: 60 });
  store.upsertOrder({ orderId: '1' });
  assert.equal(onDisk(file).orders.length, 1);
  for (let index = 2; index <= 20; index += 1) {
    store.upsertOrder({ orderId: String(index) });
  }
  assert.equal(onDisk(file).orders.length, 1);
  assert.equal(store.read().orders.length, 20);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(onDisk(file).orders.length, 20);
  assert.equal(store.flushCount, 2);
});

test('flush() writes pending changes at once (SIGTERM / exit), and does nothing when the file is current', () => {
  const { dir, file } = tempFile();
  const store = new JsonStore(file, { logger: quiet, flushIntervalMs: 60000 });
  store.upsertOrder({ orderId: '1' });
  store.appendMessage({ orderId: '1', text: 'hi' });
  assert.equal(onDisk(file).messages.length, 0);
  assert.equal(store.flush(), true);
  assert.equal(onDisk(file).messages.length, 1);
  const count = store.flushCount;
  store.flush();
  assert.equal(store.flushCount, count);
  assert.deepEqual(fs.readdirSync(dir), ['db.json']);
});

test('a failed write keeps the data in memory and the old file whole; the next flush writes it', () => {
  const { dir, file } = tempFile();
  const errors = [];
  const store = new JsonStore(file, { logger: { ...quiet, error: (m) => errors.push(m) }, flushIntervalMs: 60000 });
  store.upsertOrder({ orderId: '1' });
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try {
    store.upsertOrder({ orderId: '2' });
    assert.equal(store.flush(), false);
  } finally {
    fs.renameSync = original;
  }
  assert.ok(errors.some((m) => m.includes('could not be written')));
  assert.deepEqual(onDisk(file).orders.map((o) => o.orderId), ['1']);
  assert.deepEqual(fs.readdirSync(dir), ['db.json']);
  assert.equal(store.flush(), true);
  assert.deepEqual(onDisk(file).orders.map((o) => o.orderId), ['1', '2']);
});

test('a transaction that throws leaves the store unchanged', () => {
  const { file } = tempFile();
  const store = new JsonStore(file, { logger: quiet });
  store.upsertOrder({ orderId: '1' });
  assert.throws(() => store.transaction((db) => { db.orders = []; throw new Error('boom'); }));
  assert.equal(store.read().orders.length, 1);
});

test('reads hand out copies: changing a result never changes the store', () => {
  const { file } = tempFile();
  const store = new JsonStore(file, { logger: quiet });
  const saved = store.upsertOrder({ orderId: '1', phone: '+212600000001' });
  saved.phone = 'changed';
  store.getOrder('1').phone = 'changed';
  store.listOrders()[0].phone = 'changed';
  store.read().orders[0].phone = 'changed';
  assert.equal(store.getOrder('1').phone, '+212600000001');
});

test('orders older than 120 days are dropped unless still open; contacts stay', () => {
  const { file } = tempFile();
  const now = Date.parse('2026-11-15T00:00:00Z');
  const old = new Date(now - 200 * DAY).toISOString();
  fs.writeFileSync(file, JSON.stringify({
    orders: [
      { orderId: 'old-done', confirmationState: 'confirmed', createdAt: old, updatedAt: old },
      { orderId: 'old-pending', confirmationState: 'pending_confirmation', createdAt: old, updatedAt: old },
      { orderId: 'old-feedback', confirmationState: 'confirmed', feedbackState: 'waiting_for_feedback', createdAt: old, updatedAt: old },
      { orderId: 'recent', confirmationState: 'cancelled', createdAt: new Date(now - 10 * DAY).toISOString() },
      { orderId: 'no-date', confirmationState: 'confirmed' }
    ],
    messages: [],
    events: [],
    contacts: [{ phone: '+212600000001', marketingStatus: 'opted_out', updatedAt: old }]
  }));
  const store = new JsonStore(file, { logger: quiet, now: () => now });
  assert.equal(store.read().orders.length, 5); // nothing is dropped by just reading
  store.upsertContact({ phone: '+212600000002' });
  assert.deepEqual(store.listOrders().map((o) => o.orderId), ['old-pending', 'old-feedback', 'recent', 'no-date']);
  assert.equal(store.read().contacts.length, 2);
  store.flush();
  assert.deepEqual(onDisk(file).orders.map((o) => o.orderId), ['old-pending', 'old-feedback', 'recent', 'no-date']);
});
