import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { JsonStore } from '../src/json-store.js';
import { OUTBOUND_LOGICAL_KEYS } from '../src/domain/order-meta.js';
import { isFreshConfirmationRequest } from '../src/services/confirmation/outbound/reserved-send.js';

const at = (iso) => new Date(iso);
const QUIET = { enabled: true, startHour: 22, endHour: 10, timeZone: 'Africa/Casablanca' };
const CONFIRMATION = OUTBOUND_LOGICAL_KEYS.confirmationRequest;

test('only the first confirmation request is exempt from quiet hours', () => {
  assert.equal(isFreshConfirmationRequest(CONFIRMATION), true);
  assert.equal(isFreshConfirmationRequest(OUTBOUND_LOGICAL_KEYS.reminder1), false, 'reminders stay quiet');
  assert.equal(isFreshConfirmationRequest(OUTBOUND_LOGICAL_KEYS.confirmationSuccess), false);
});

function makeService(clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  const sent = [];
  const service = new ConfirmationService({
    store: new JsonStore(path.join(dir, 'db.json')),
    wasenderClient: { sendMessage: async (payload) => { sent.push(payload); return { success: true, data: { msgId: 9 } }; } },
    wooClient: {
      getOrder: async (id) => ({ id, meta_data: [] }),
      updateOrderMeta: async (id, meta) => ({ id, meta_data: meta }),
      addOrderNote: async () => ({})
    },
    messages: { quietHours: QUIET, confirmationTemplate: 'Confirm {{orderId}}' },
    logger: { log() {}, warn() {}, error() {} }
  });
  service.clock = clock;
  service.claimSettleMs = 0;
  service.sleep = async () => {};
  return { service, sent };
}

async function send(service, orderPayload, now) {
  return service.sendLogicalMessageWithWooReservation({
    orderPayload,
    orderId: String(orderPayload.id),
    phone: '+212600000051',
    logicalKey: CONFIRMATION,
    kind: 'confirmation_request',
    message: 'Confirm',
    now
  });
}

test('night order: the first confirmation is sent at once, however old the order, and a reminder still waits', async () => {
  const now = at('2026-11-15T23:50:00Z'); // 00:50 in Morocco = quiet hours
  const { service, sent } = makeService(() => now);

  const first = await send(service, { id: 601, date_created_gmt: '2026-11-15T15:00:00', meta_data: [] }, now);
  assert.notEqual(first.deferred, true, 'the confirmation request ignores the night pause');
  assert.equal(sent.length, 1);

  const { service: s2, sent: sent2 } = makeService(() => now);
  const reminder = await s2.sendLogicalMessageWithWooReservation({
    orderPayload: { id: 602, meta_data: [] }, orderId: '602', phone: '+212600000051',
    logicalKey: OUTBOUND_LOGICAL_KEYS.reminder1, kind: 'reminder_1', message: 'Reminder', now
  });
  assert.equal(reminder.deferred, true, 'reminders still wait for 10:00');
  assert.equal(sent2.length, 0);
});
