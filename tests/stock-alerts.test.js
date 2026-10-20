import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { StockAlertService } from '../src/services/stock-alert-service.js';

const quietLogger = { log() {}, warn() {}, error() {} };

function context({ failSend = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-alerts-'));
  const store = new JsonStore(path.join(dir, 'db.json'));
  const sent = [];
  const wasenderClient = {
    async sendMessage(payload) {
      if (failSend) {
        throw new Error('session disconnected');
      }
      sent.push(payload);
      return { id: `msg-${sent.length}` };
    }
  };
  const service = new StockAlertService({ store, wasenderClient, logger: quietLogger, autoProcess: false });
  const app = createApp({
    config: { tasks: { secret: 'task-secret' }, woo: { webhookSecret: 'x' }, wasender: { webhookSecret: 'x', signatureHeader: 'x' } },
    confirmationService: {},
    store,
    stockAlertService: service,
    logger: quietLogger
  });
  return { store, sent, service, app };
}

const alert = (overrides = {}) => ({
  id: '11',
  phone: '+212612345678',
  productName: 'Rhymat Baggy Military Cargo',
  size: 'L',
  productUrl: 'https://rhymat.ma/product/rhymat-baggy-military-cargo/',
  ...overrides
});

function dispatch(app, { headers = {}, payload = {} }) {
  const body = JSON.stringify(payload);
  const req = {
    method: 'POST',
    url: '/tasks/stock-alerts',
    headers,
    on(event, callback) {
      if (event === 'data') {
        callback(body);
      }
      if (event === 'end') {
        callback();
      }
    }
  };
  const res = {
    statusCode: 200,
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      this.body = text;
    }
  };
  return app(req, res).then(() => ({ statusCode: res.statusCode, body: JSON.parse(res.body) }));
}

function dispatchGet(app, { headers = {}, url }) {
  const req = { method: 'GET', url, headers, on(event, callback) { if (event === 'end') { callback(); } } };
  const res = { statusCode: 200, writeHead(code) { this.statusCode = code; }, end(text) { this.body = text; } };
  return app(req, res).then(() => ({ statusCode: res.statusCode, body: JSON.parse(res.body) }));
}

test('queued stock alert is sent once with size, product and link', async () => {
  const { service, sent, store } = context();
  const result = service.accept([alert()]);
  assert.deepEqual(result.accepted, ['11']);
  await service.processQueue();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+212612345678');
  assert.match(sent[0].message, /taille L de Rhymat Baggy Military Cargo/u);
  assert.match(sent[0].message, /https:\/\/rhymat\.ma\/product\/rhymat-baggy-military-cargo\//u);
  assert.match(sent[0].message, /STOP/u);
  assert.equal(store.read().stockAlerts[0].status, 'sent');
});

test('the same alert id is never sent twice', async () => {
  const { service, sent } = context();
  service.accept([alert()]);
  await service.processQueue();
  const again = service.accept([alert()]);
  await service.processQueue();

  assert.deepEqual(again.accepted, []);
  assert.deepEqual(again.skipped, [{ id: '11', reason: 'already_handled' }]);
  assert.equal(sent.length, 1);
});

test('opted-out, invalid and duplicate subscribers are skipped', async () => {
  const { service, sent, store } = context();
  store.upsertContact({ phone: '+212600000001', marketingStatus: 'opted_out' });
  const result = service.accept([
    alert({ id: '1', phone: '+212600000001' }),
    alert({ id: '2', phone: 'abc' }),
    alert({ id: '3', phone: '+212611111111' }),
    alert({ id: '4', phone: '+212611111111' }),
    alert({ id: '5', phone: '+212622222222', productUrl: 'not-a-url' })
  ]);
  await service.processQueue();

  assert.deepEqual(result.accepted, ['3']);
  assert.deepEqual(
    result.skipped.map((item) => `${item.id}:${item.reason}`).sort(),
    ['1:opted_out', '2:invalid_phone', '4:duplicate', '5:invalid_product']
  );
  assert.equal(sent.length, 1);
});

test('a failed send is marked failed and is queued again when handed over again', async () => {
  const failing = context({ failSend: true });
  failing.service.accept([alert()]);
  await failing.service.processQueue();
  assert.equal(failing.store.read().stockAlerts[0].status, 'failed');

  const retry = failing.service.accept([alert()]);
  assert.deepEqual(retry.accepted, ['11']);
  assert.equal(failing.store.read().stockAlerts[0].status, 'queued');
});

test('POST /tasks/stock-alerts needs the task secret and answers 202 right away', async () => {
  const { app, store } = context();

  const denied = await dispatch(app, { payload: { alerts: [alert()] } });
  assert.equal(denied.statusCode, 401);

  const badBody = await dispatch(app, { headers: { 'x-task-secret': 'task-secret' }, payload: { nope: true } });
  assert.equal(badBody.statusCode, 400);

  const ok = await dispatch(app, { headers: { 'x-task-secret': 'task-secret' }, payload: { alerts: [alert()] } });
  assert.equal(ok.statusCode, 202);
  assert.deepEqual(ok.body.accepted, ['11']);
  assert.equal(store.read().stockAlerts.length, 1);
});

test('a drop notice uses the drop template and is separate from a size alert for the same product', async () => {
  const { service, sent } = context();
  const drop = alert({ id: 'drop-5-1', kind: 'drop', size: '', earlyMinutes: 15 });
  const result = service.accept([drop, alert({ id: '12' })]);
  assert.deepEqual(result.accepted, ['drop-5-1', '12']);
  await service.processQueue();
  assert.equal(sent.length, 2);
  assert.match(sent[0].message, /Nouveau drop Rhymat/u);
  assert.match(sent[0].message, /15 min avant/u);
  assert.match(sent[1].message, /taille L/u);
});

test('status endpoint reports queued, sent and unknown alerts', async () => {
  const { service, app } = context();
  service.accept([alert({ id: '21' }), alert({ id: '22', phone: '+212611111111' })]);
  await service.processQueue();
  const res = await dispatchGet(app, { headers: { 'x-task-secret': 'task-secret' }, url: '/tasks/stock-alerts/status?ids=21,22,99' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.statuses, { 21: 'sent', 22: 'sent', 99: 'unknown' });
  const denied = await dispatchGet(app, { headers: {}, url: '/tasks/stock-alerts/status?ids=21' });
  assert.equal(denied.statusCode, 401);
});
