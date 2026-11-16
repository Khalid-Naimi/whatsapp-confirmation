import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { JsonStore } from '../src/json-store.js';
import { OUTBOUND_LOGICAL_KEYS } from '../src/domain/order-meta.js';
import { isFreshConfirmationRequest, FRESH_ORDER_MAX_AGE_MS } from '../src/services/confirmation/outbound/reserved-send.js';

const at = (iso) => new Date(iso);
const QUIET = { enabled: true, startHour: 22, endHour: 10, timeZone: 'Africa/Casablanca' };
const CONFIRMATION = OUTBOUND_LOGICAL_KEYS.confirmationRequest;

test('fresh order: only the first confirmation of a recent order is exempt from quiet hours', () => {
  const now = at('2026-11-15T23:50:00Z'); // 00:50 in Morocco
  const placed = (iso) => ({ date_created_gmt: iso });
  assert.equal(isFreshConfirmationRequest(CONFIRMATION, placed('2026-11-15T23:48:09'), now), true, 'placed 2 minutes ago');
  assert.equal(isFreshConfirmationRequest(CONFIRMATION, placed('2026-11-15T23:48:09Z'), now), true, 'zone given');
  assert.equal(isFreshConfirmationRequest(CONFIRMATION, placed('2026-11-15T20:00:00'), now), false, 'placed 3h50m ago, the customer may be asleep');
  assert.equal(isFreshConfirmationRequest(CONFIRMATION, placed('2026-11-15T19:00:00'), now), false, 'older');
  assert.equal(isFreshConfirmationRequest(OUTBOUND_LOGICAL_KEYS.reminder1, placed('2026-11-15T23:48:09'), now), false, 'reminders stay quiet');
  assert.equal(isFreshConfirmationRequest(CONFIRMATION, {}, now), true, 'no readable date: do not block a new customer');
  assert.equal(FRESH_ORDER_MAX_AGE_MS, 3 * 60 * 60 * 1000);
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

test('night order: the first confirmation is sent at once, an older one waits for the morning', async () => {
  const now = at('2026-11-15T23:50:00Z'); // 00:50 in Morocco = quiet hours
  const { service, sent } = makeService(() => now);

  const fresh = await send(service, { id: 601, date_created_gmt: '2026-11-15T23:48:09', meta_data: [] }, now);
  assert.notEqual(fresh.deferred, true, 'a customer who just ordered gets the confirmation now');
  assert.equal(sent.length, 1);

  const { service: s2, sent: sent2 } = makeService(() => now);
  const old = await send(s2, { id: 602, date_created_gmt: '2026-11-15T15:00:00', meta_data: [] }, now);
  assert.equal(old.deferred, true, 'an order from the afternoon still waits for 10:00');
  assert.equal(sent2.length, 0);
});
