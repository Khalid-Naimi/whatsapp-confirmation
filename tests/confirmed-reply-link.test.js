import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { CONFIRMED_REPLY_TEMPLATE } from '../src/config.js';
import { OUTBOUND_LOGICAL_KEYS } from '../src/domain/order-meta.js';

function makeService(messages = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmed-link-'));
  const sent = [];
  const service = new ConfirmationService({
    store: new JsonStore(path.join(dir, 'db.json')),
    wasenderClient: { sendMessage: async (payload) => { sent.push(payload); return { success: true, data: { msgId: 9 } }; } },
    wooClient: { updateOrderMeta: async (id, meta) => ({ id, meta_data: meta }), addOrderNote: async () => ({}) },
    messages: { deliveryEtaCasablanca: '24h', deliveryEtaOtherCities: '2 days', ...messages },
    logger: { log() {}, warn() {}, error() {} }
  });
  return { service, sent };
}

const ORDER = {
  id: 10412,
  status: 'on-hold',
  total: '129',
  billing: { first_name: 'Yassine', last_name: 'Test', phone: '+212600000041', city: 'Marrakech' },
  shipping: { city: 'Marrakech' },
  line_items: [{ name: 'Cap', quantity: 1 }],
  meta_data: []
};

async function sendConfirmed(service, message) {
  await service.sendCustomerDecisionReply({
    order: { orderId: '10412', phone: '+212600000041', customerReplySent: 'no' },
    decisionOrderPayload: ORDER,
    phone: '+212600000041',
    logicalKey: OUTBOUND_LOGICAL_KEYS.confirmationSuccess,
    nextState: 'confirmed',
    nowIso: '2026-11-19T10:00:00Z',
    currentInvalidReplyCount: 0,
    message
  });
}

test('the confirmed reply carries the name, the order number and the tracking link', async () => {
  const { service, sent } = makeService();
  await sendConfirmed(service, CONFIRMED_REPLY_TEMPLATE);
  assert.equal(sent.length, 1);
  const text = sent[0].text ?? sent[0].message ?? '';
  assert.equal(text, [
    'Chokran Yassine Test, la commande dyalk t confirmat.',
    'Numero dyal la commande: 10412',
    'Suivi: rhymat.ma/suivi?n=10412',
    'Ghadi ytwasl m3ak livreur mli twsl lmdintk.'
  ].join('\n'));
});

test('the tracking address can be changed, and a reply without placeholders is sent as written', async () => {
  const { service, sent } = makeService({ trackingUrlBase: 'shop.example/track/' });
  await sendConfirmed(service, 'Suivi: {{trackingUrl}}');
  assert.equal(sent[0].text ?? sent[0].message, 'Suivi: shop.example/track?n=10412');
  const second = makeService();
  await sendConfirmed(second.service, 'Merci');
  assert.equal(second.sent[0].text ?? second.sent[0].message, 'Merci');
});
