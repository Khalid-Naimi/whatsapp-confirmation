import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';

const quiet = { log() {}, warn() {}, error() {} };

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-'));
  return { dir, file: path.join(dir, 'db.json') };
}

test('a missing file starts empty and is created', () => {
  const { file } = tempFile();
  const store = new JsonStore(file, { logger: quiet });
  assert.deepEqual(store.read().orders, []);
  assert.ok(fs.existsSync(file));
});

test('an empty file is read as an empty store', () => {
  const { file } = tempFile();
  fs.writeFileSync(file, '');
  const store = new JsonStore(file, { logger: quiet });
  assert.deepEqual(store.read(), { orders: [], messages: [], events: [], contacts: [] });
});

test('a corrupt file is moved aside, the store starts empty and logs it', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, '{"orders": [ broken');
  const errors = [];
  const store = new JsonStore(file, { logger: { ...quiet, error: (message) => errors.push(message) } });
  assert.deepEqual(store.read().orders, []);
  const aside = fs.readdirSync(dir).filter((name) => name.startsWith('db.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"orders": [ broken');
  assert.ok(errors.some((message) => message.includes('moved to db.json.corrupt-')));
  store.upsertOrder({ orderId: '1' });
  assert.equal(store.getOrder('1').orderId, '1');
});

test('writes leave no temporary files behind and replace the file whole', () => {
  const { dir, file } = tempFile();
  const store = new JsonStore(file, { logger: quiet });
  store.upsertOrder({ orderId: '7', phone: '+212600000007' });
  store.appendMessage({ orderId: '7', text: 'hello' });
  assert.deepEqual(fs.readdirSync(dir), ['db.json']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).orders[0].orderId, '7');
});

test('events and messages are capped to the newest entries', () => {
  const { file } = tempFile();
  const store = new JsonStore(file, { logger: quiet, limits: { events: 3, messages: 2 } });
  for (let index = 0; index < 6; index += 1) {
    store.recordEvent('test', `key-${index}`, { id: index });
    store.appendMessage({ orderId: String(index) });
  }
  const db = store.read();
  assert.deepEqual(db.events.map((event) => event.eventKey), ['key-3', 'key-4', 'key-5']);
  assert.deepEqual(db.messages.map((message) => message.orderId), ['4', '5']);
});

test('events keep a small summary instead of the full webhook body', () => {
  const { file } = tempFile();
  const store = new JsonStore(file, { logger: quiet });
  store.recordEvent('woocommerce', 'd-1', {
    id: 42,
    status: 'processing',
    billing: { first_name: 'Secret', phone: '+212600000042', address_1: '1 Rue Privee' }
  }, 'processed');
  const [event] = store.read().events;
  assert.equal(event.status, 'processed');
  assert.deepEqual(event.payload, { id: 42, status: 'processing', keys: ['billing', 'id', 'status'] });
  assert.ok(!JSON.stringify(event).includes('+212600000042'));
  assert.ok(!JSON.stringify(event).includes('Rue Privee'));
});
