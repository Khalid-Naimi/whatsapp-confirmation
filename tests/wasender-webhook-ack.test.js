// The HTTP route: POST /webhooks/wasender is answered before the slow part of the work is done, and the pure parser
// that now lives in its own module still reads both message shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import {
  extractWasenderInboundMessages,
  summarizeWasenderRequestStatus
} from '../src/services/confirmation/inbound/wasender-parser.js';

const quiet = { log() {}, warn() {}, error() {} };

function request(app, payload) {
  const body = JSON.stringify(payload);
  const req = {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: { 'x-wasender-signature': 'wasender-secret' },
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
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(text) { this.body = text; }
  };
  return Promise.resolve(app(req, res)).then(() => ({ statusCode: res.statusCode, body: JSON.parse(res.body) }));
}

test('POST /webhooks/wasender answers 200 before a slow WooCommerce has finished; the work completes after', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = {
    id: 901,
    status: 'processing',
    total: '100',
    billing: { first_name: 'A', phone: '+212600000901', state: 'Casablanca', address_1: 'Rue 1' },
    line_items: [{ name: 'Tee', quantity: 1 }],
    meta_data: [
      { key: 'rhymat_whatsapp_state', value: 'pending' },
      { key: 'rhymat_whatsapp_confirmation_sent_at', value: new Date().toISOString() },
      { key: 'rhymat_whatsapp_confirmation_request_state', value: 'sent' }
    ]
  };
  const writes = [];
  const wooClient = {
    // A slow shop: every order read waits until the test lets it go.
    async getOrder() { await gate; return structuredClone(order); },
    async listOrdersByStatuses(statuses) { await gate; return statuses.includes(order.status) ? [structuredClone(order)] : []; },
    async listOrders() { return []; },
    async updateOrder(id, fields) { writes.push(fields); return structuredClone(order); },
    async updateOrderMeta(id, rows) { writes.push({ meta_data: rows }); return structuredClone(order); },
    async updateOrderStatus(id, status) { writes.push({ status }); return structuredClone(order); },
    async addOrderNote() { return {}; }
  };
  const sends = [];
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ack-http-')), 'db.json'), { logger: quiet });
  const confirmationService = new ConfirmationService({
    store,
    wasenderClient: { async sendMessage(payload) { sends.push(payload); return { id: 'm' }; }, async sendPoll() { return {}; } },
    wooClient,
    messages: { confirmedReply: 'Merci', cancelledReply: 'Annulee', invalidReply: 'x', internalNotifyPhones: [], internalConfirmedTemplate: '', internalCancelledTemplate: '', defaultCityLabel: 'Maghrib' },
    claimSettleMs: 0,
    inboundAckBudgetMs: 30,
    logger: quiet
  });
  const app = createApp({
    config: { tasks: { secret: 't' }, woo: { webhookSecret: 'w' }, wasender: { webhookSecret: 'wasender-secret', signatureHeader: 'x-wasender-signature' } },
    confirmationService,
    store,
    logger: quiet
  });

  const started = Date.now();
  const answer = await request(app, { data: { messages: { key: { id: 'wamid-901', cleanedSenderPn: '212600000901', fromMe: false }, messageBody: '1' } } });
  assert.ok(Date.now() - started < 1000);
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.body.accepted, true);
  assert.equal(writes.length, 0);
  assert.equal(sends.length, 0);

  release();
  await confirmationService.drain();
  assert.ok(writes.some((write) => write.status === 'on-hold'));
  assert.deepEqual(sends.map((send) => send.message), ['Merci']);
});

test('the Wasender parser (its own module now) reads a text message and a poll vote', () => {
  const text = extractWasenderInboundMessages({ data: { messages: { key: { id: 'abc', cleanedSenderPn: '212600000111', fromMe: false }, messageBody: ' 2 ' } } }, 'e1', quiet);
  assert.equal(text.length, 1);
  assert.deepEqual([text[0].messageKey, text[0].senderPhone, text[0].kind, text[0].textBody], ['abc', '+212600000111', 'text', ' 2 ']);
  const votes = extractWasenderInboundMessages({
    event: 'poll.results',
    data: { key: { id: 'poll-1', fromMe: true }, pollResult: [{ name: 'Confirmer', voters: ['212600000222@s.whatsapp.net'] }, { name: 'Annuler', voters: [] }] }
  }, 'e2', quiet);
  assert.deepEqual(votes.map((vote) => [vote.messageKey, vote.textBody]), [['poll:poll-1:+212600000222:1', '1']]);
  assert.equal(summarizeWasenderRequestStatus(['confirmed', 'processing_failed']), 'batch_processed_with_failures');
});
