// The Wasender webhook answers quickly and the work goes on as tracked background tasks; drain() waits for them and
// flushDueConfirmations() prepares a shutdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';

const quiet = { log() {}, warn() {}, error() {} };

const messages = {
  confirmationTemplate: 'Confirmez {{orderId}}',
  reminderMessage: 'Rappel {{orderId}}',
  invalidReply: 'Repondez 1 ou 2',
  confirmedReply: 'Merci',
  cancelledReply: 'Annulee',
  internalNotifyPhones: ['+212700000001'],
  internalConfirmedTemplate: 'ok {{orderId}}',
  internalCancelledTemplate: 'ko {{orderId}}',
  deliveryEtaCasablanca: '24h',
  deliveryEtaOtherCities: '48h',
  defaultCityLabel: 'Maghrib'
};

function order(id) {
  return {
    id,
    status: 'processing',
    total: '100',
    billing: { first_name: 'Test', phone: `+2126000${String(id).padStart(5, '0')}`, state: 'Casablanca', address_1: 'Rue 1' },
    line_items: [{ name: 'Tee', quantity: 1 }],
    meta_data: []
  };
}

function fakeWoo(orders) {
  const live = new Map(orders.map((item) => [String(item.id), structuredClone(item)]));
  const woo = {
    async getOrder(id) {
      const found = live.get(String(id));
      if (!found) {
        throw new Error('not found');
      }
      return structuredClone(found);
    },
    async updateOrder(id, fields) {
      const found = live.get(String(id));
      if (fields.status) {
        found.status = fields.status;
      }
      for (const row of fields.meta_data || []) {
        const at = found.meta_data.findIndex((item) => item.key === row.key);
        if (at >= 0) {
          found.meta_data[at] = { key: row.key, value: row.value };
        } else {
          found.meta_data.push({ key: row.key, value: row.value });
        }
      }
      return structuredClone(found);
    },
    async updateOrderMeta(id, rows) { return woo.updateOrder(id, { meta_data: rows }); },
    async updateOrderStatus(id, status) { return woo.updateOrder(id, { status }); },
    async addOrderNote() { return {}; },
    async listOrdersByStatuses(statuses) { return [...live.values()].filter((item) => statuses.includes(item.status)).map((item) => structuredClone(item)); },
    async listOrders() { return []; }
  };
  const metaOf = (id, key) => live.get(String(id))?.meta_data.find((row) => row.key === key)?.value;
  return { woo, live, metaOf };
}

// A WhatsApp provider whose customer sends can be held until the test lets them go.
function gatedWasender() {
  const sends = [];
  let open = true;
  let release = () => {};
  let gate = Promise.resolve();
  return {
    sends,
    hold() {
      open = false;
      gate = new Promise((resolve) => { release = resolve; });
    },
    letGo() {
      open = true;
      release();
    },
    client: {
      async sendMessage(payload) {
        if (!open && !String(payload.to).startsWith('+2127')) {
          await gate;
        }
        sends.push(payload);
        return { id: `m${sends.length}` };
      },
      async sendPoll() { return {}; }
    }
  };
}

function makeService(woo, wasender, extra = {}) {
  return new ConfirmationService({
    store: new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ack-')), 'db.json'), { logger: quiet }),
    wasenderClient: wasender.client,
    wooClient: woo,
    messages: { ...messages, ...(extra.messages || {}) },
    claimSettleMs: 0,
    inboundAckBudgetMs: extra.inboundAckBudgetMs ?? 1000,
    logger: quiet
  });
}

const reply = (id, phone, text) => ({ data: { messages: { key: { id, cleanedSenderPn: phone, fromMe: false }, messageBody: text } } });

test('the Wasender webhook answers before the slow work is done; drain() waits for it', async () => {
  const { woo, live, metaOf } = fakeWoo([order(801)]);
  const wasender = gatedWasender();
  const service = makeService(woo, wasender, { inboundAckBudgetMs: 20 });
  await service.sendInitialConfirmation(order(801));
  assert.equal(wasender.sends.length, 1);

  wasender.hold();
  const started = Date.now();
  const answer = await service.processWasenderInbound(reply('wamid-801', '212600000801', '1'), 'event-801');
  assert.ok(Date.now() - started < 1000);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { ok: true, accepted: true, pending: 1, messageCount: 1, duplicates: 0 });
  // The decision is written, the customer's "thank you" is still waiting on the provider.
  assert.equal(wasender.sends.filter((send) => send.message === 'Merci').length, 0);

  // The same delivery again while it is still being handled is a duplicate.
  const again = await service.processWasenderInbound(reply('wamid-801', '212600000801', '1'), 'event-801');
  assert.deepEqual(again.body, { ok: true, duplicate: true });

  let drained = false;
  const draining = service.drain().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(drained, false);
  wasender.letGo();
  await draining;
  assert.equal(wasender.sends.filter((send) => send.message === 'Merci').length, 1);
  assert.equal(metaOf(801, 'rhymat_whatsapp_decision'), 'confirmed');
  assert.equal(live.get('801').status, 'on-hold');
  assert.equal(service.backgroundTasks.size, 0);
});

test('fast work still answers with the full summary, as before', async () => {
  const { woo } = fakeWoo([order(802)]);
  const wasender = gatedWasender();
  const service = makeService(woo, wasender);
  await service.sendInitialConfirmation(order(802));
  const answer = await service.processWasenderInbound(reply('wamid-802', '212600000802', '1'), 'event-802');
  assert.equal(answer.body.confirmation, 1);
  assert.equal(answer.body.processed, 1);
  const replay = await service.processWasenderInbound(reply('wamid-802', '212600000802', '1'), 'event-802b');
  assert.equal(replay.body.duplicates, 1);
});

test('a message seen again after a restart (empty memory) is recognised from the order meta, no second reply', async () => {
  const { woo } = fakeWoo([order(803)]);
  const wasender = gatedWasender();
  const before = makeService(woo, wasender);
  await before.sendInitialConfirmation(order(803));
  const pendingCopy = before.store.getOrder('803');
  await before.processWasenderInbound(reply('wamid-803', '212600000803', '1'), 'event-803');
  await before.drain();
  const thanks = wasender.sends.filter((send) => send.message === 'Merci').length;
  assert.equal(thanks, 1);

  // A new process: nothing in memory, a cache that still sees the order as waiting for an answer.
  const after = makeService(woo, wasender);
  after.store.upsertOrder(pendingCopy);
  const answer = await after.processWasenderInbound(reply('wamid-803', '212600000803', '1'), 'event-803-retry');
  await after.drain();
  assert.equal(answer.body.duplicates, 1);
  assert.equal(wasender.sends.filter((send) => send.message === 'Merci').length, thanks);
});

test('drain() also waits for a first confirmation whose timer fired and for the HighDelivery auto-send', async () => {
  const { woo } = fakeWoo([order(804)]);
  const wasender = gatedWasender();
  const service = makeService(woo, wasender, { messages: { confirmationDelayMs: 5 } });
  let autoSendDone = false;
  service.hdAutoSend = {
    enabled: true,
    async autoSend() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      autoSendDone = true;
      return { status: 'sent' };
    }
  };
  wasender.hold();
  const scheduled = await service.processWooOrder(order(804), 'delivery-804');
  assert.equal(scheduled.body.scheduled, true);
  service.scheduleHdAutoSend({ orderId: '999' });
  await new Promise((resolve) => setTimeout(resolve, 20)); // the 5 ms timer has fired, the send waits on the provider
  assert.equal(service.pendingInitialConfirmations.has('804'), true);
  const draining = service.drain();
  wasender.letGo();
  await draining;
  assert.equal(wasender.sends.length, 1);
  assert.equal(autoSendDone, true);
  assert.equal(service.pendingInitialConfirmations.size, 0);
});

test('flushDueConfirmations(): a due first message starts now, one not due yet is left to the hourly backfill', async () => {
  const { woo, metaOf } = fakeWoo([order(805), order(806)]);
  const wasender = gatedWasender();
  const logs = [];
  const service = makeService(woo, wasender, { messages: { confirmationDelayMs: 60000 } });
  service.logger = { log() {}, warn: (line) => logs.push(line), error() {} };
  await service.processWooOrder(order(805), 'delivery-805');
  // Order 806 was scheduled 59 seconds earlier: its wait is over by "now" below.
  await service.processWooOrder(order(806), 'delivery-806');
  service.initialConfirmationDueAt.get('806').dueAt = Date.now() - 1000;

  const result = service.flushDueConfirmations();
  assert.deepEqual(result, { started: ['806'], leftToBackfill: ['805'] });
  assert.equal(service.pendingInitialConfirmations.has('805'), false);
  assert.ok(logs.some((line) => line.includes('orderId=805') && line.includes('hourly backfill')));
  await service.drain();
  assert.equal(wasender.sends.length, 1);
  assert.equal(wasender.sends[0].message, 'Confirmez 806');
  assert.equal(metaOf(806, 'rhymat_whatsapp_confirmation_request_state'), 'sent');
  assert.equal(metaOf(805, 'rhymat_whatsapp_confirmation_request_state'), undefined);

  // The hourly backfill then sends the one left behind (the timer is gone, so it is not "scheduled" any more).
  const summary = await service.runOrderFollowups({ backfillOnly: true });
  assert.equal(summary.backfilled, 1);
  assert.equal(wasender.sends.at(-1).message, 'Confirmez 805');
});

test('the WooCommerce order webhook answers within its budget while the order lock is held; the work finishes after', async () => {
  const { woo } = fakeWoo([order(807)]);
  const wasender = gatedWasender();
  const service = new ConfirmationService({
    store: new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ack-woo-')), 'db.json'), { logger: quiet }),
    wasenderClient: wasender.client,
    wooClient: woo,
    messages: { ...messages, confirmationDelayMs: 0 },
    claimSettleMs: 0,
    wooAckBudgetMs: 20,
    logger: quiet
  });
  let release;
  const held = service.withOrderLock('807', () => new Promise((resolve) => { release = resolve; }));
  const started = Date.now();
  const answer = await service.processWooOrder(order(807), 'delivery-807');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(answer, { status: 200, body: { ok: true, accepted: true, pending: true } });
  // The same delivery again while it is still pending is a duplicate.
  assert.equal((await service.processWooOrder(order(807), 'delivery-807')).body.reason, 'event_in_flight');
  assert.equal(wasender.sends.length, 0);
  release();
  await held;
  await service.drain();
  assert.equal(wasender.sends.length, 1);
});
