// The "manage my order" page: limits, message variants, number change, replacement orders and the customer cancel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { HdAutoSendService } from '../src/services/hd-auto-send-service.js';
import { HighDeliveryError } from '../src/services/highdelivery-client.js';
import { WasenderSendError } from '../src/services/wasender-client.js';
import { CONFIRMED_REPLY_TEMPLATE } from '../src/config.js';
import { computeReservations } from '../src/services/stock-sync-service.js';

const quiet = { log() {}, warn() {}, error() {} };
const PHONE = '+212600000001';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const metaOf = (order, key) => (order.meta_data || []).find((row) => row.key === key)?.value ?? '';
const metaList = (values) => Object.entries(values).map(([key, value]) => ({ key, value }));
const clone = (value) => structuredClone(value);

const SENT = (at = '2026-11-20T09:00:00.000Z') => ({
  rhymat_whatsapp_state: 'pending',
  rhymat_whatsapp_confirmation_sent_at: at,
  rhymat_whatsapp_confirmation_request_state: 'sent'
});
const CONFIRMED = { ...SENT(), rhymat_whatsapp_state: 'confirmed', rhymat_whatsapp_decision: 'confirmed', rhymat_whatsapp_woo_sync_status: 'synced', rhymat_whatsapp_customer_reply_sent: 'yes' };
const PARCEL = { rhymat_hd_api_state: 'sent', rhymat_hd_api_tracking: 'HD-1' };

function order(id, { status = 'processing', meta = {}, phone = '212600000001', created = '2026-11-20T08:59:00' } = {}) {
  return {
    id,
    status,
    total: '199.00',
    currency: 'MAD',
    date_created_gmt: created,
    billing: { first_name: 'Sara', last_name: 'Test', phone, state: 'Rabat', address_1: 'Rue 1' },
    line_items: [{ name: 'Cap', quantity: 1 }],
    meta_data: metaList(meta)
  };
}

const replacement = (id, oldId, meta = {}) => order(id, { meta: { rhymat_replaces: String(oldId), rhymat_wa_manage_count: 1, ...meta } });
const waitingReplacement = (id, oldId) => replacement(id, oldId, { ...SENT('2026-11-20T10:00:00.000Z'), rhymat_wa_manage_count: 2, rhymat_wa_manage_last_at: '2026-11-20T10:00:00.000Z' });
const confirmedOld = (id, pendingId, extra = {}) => order(id, { status: 'on-hold', meta: { ...CONFIRMED, rhymat_replacement_pending: String(pendingId), ...extra } });

function setup(orders = [], { parcels = [], cancelParcel = null, shopLimit = 60, quietNow = false, trust = 50, products = {}, holdMs = 90000, poll = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-'));
  const store = new JsonStore(path.join(dir, 'db.json'));
  const shop = new Map(orders.map((item) => [String(item.id), item]));
  const sent = [];
  const teamNotices = [];
  const mails = [];
  const hdCancels = [];
  const created = [];
  const now = { value: new Date('2026-11-20T10:00:00.000Z') };
  const quietState = { on: quietNow };
  const send = { error: null, before: null };
  const polls = [];

  const wooClient = {
    async getOrder(id) {
      const found = shop.get(String(id));
      if (!found) {
        throw Object.assign(new Error('WooCommerce request failed with 404'), { status: 404 });
      }
      return clone(found);
    },
    async updateOrder(id, fields) {
      const found = shop.get(String(id));
      for (const [key, value] of Object.entries(fields)) {
        if (key !== 'meta_data') {
          found[key] = value;
          continue;
        }
        for (const row of value) {
          const existing = found.meta_data.find((item) => item.key === row.key);
          if (existing) { existing.value = row.value; } else { found.meta_data.push({ ...row }); }
        }
      }
      return clone(found);
    },
    async updateOrderStatus(id, status) { return this.updateOrder(id, { status }); },
    async updateOrderMeta(id, meta) { return this.updateOrder(id, { meta_data: meta }); },
    async addOrderNote() { return {}; },
    async getProduct(id) { return products[id]; },
    async listVariations(id) { return products[id]?.variations || []; },
    async listOrdersByStatuses(statuses) { return [...shop.values()].filter((item) => statuses.includes(item.status)).map(clone); },
    async listOrders({ status, page = 1 }) { return page === 1 ? this.listOrdersByStatuses([status]) : []; }
  };
  const wasenderClient = {
    async sendMessage({ to, message, beforeDispatch }) {
      if (beforeDispatch) { await beforeDispatch(); }
      if (send.before) { send.before(); }
      if (send.error) { throw send.error; }
      sent.push({ to, message });
      return { id: `m${sent.length}` };
    },
    async sendPoll(payload) { polls.push(payload); return { id: 'p' }; }
  };
  const hdClient = {
    isConfigured: () => true,
    async listPackages() { return clone(parcels); },
    async cancelPackage(id) {
      hdCancels.push(id);
      if (cancelParcel) { return cancelParcel(id); }
      parcels.find((row) => row.id === id).status = 'cancelled';
      return {};
    },
    async trustScore() { return { score: trust, blacklisted: false, totalOrders: 1, deliveredOrders: 0, failedOrders: 0 }; },
    async createPackage(parcel) { created.push(parcel); return { trackingNumber: `HD-NEW-${created.length}` }; }
  };
  const hdAutoSend = new HdAutoSendService({ hdClient, wooClient, wasenderClient, store, enabled: true, claimSettleMs: 0, logger: quiet });
  const service = new ConfirmationService({
    store,
    wasenderClient,
    wooClient,
    hdAutoSend,
    mailService: { async send(mail) { mails.push(mail); } },
    notifyTeam: async (text) => { teamNotices.push(text); return 1; },
    manageSecret: 'task-secret',
    manageDailyShopLimit: shopLimit,
    manageHoldMs: holdMs,
    messages: {
      confirmationPollEnabled: poll,
      confirmationTemplate: 'Salam {{customerName}} #{{orderId}} {{orderItemsSummary}} {{deliveryAddress}}',
      confirmedReply: CONFIRMED_REPLY_TEMPLATE,
      cancelledReply: 'Annulee',
      invalidReply: '1 ou 2',
      reminderMessage: 'Rappel {{orderId}}',
      internalNotifyPhones: [],
      internalConfirmedTemplate: '',
      internalCancelledTemplate: '',
      defaultCityLabel: 'Maghrib',
      confirmationDelayMs: 0
    },
    claimSettleMs: 0,
    logger: quiet
  });
  service.clock = () => now.value;
  service.isQuietNow = () => quietState.on;

  let replies = 0;
  const reply = async (text, from = PHONE) => {
    replies += 1;
    const result = await service.processWasenderInbound({ data: { messages: { key: { id: `in-${replies}`, cleanedSenderPn: from.slice(1) }, messageBody: text } } }, `event-${replies}`);
    await service.drain();
    return result;
  };
  const get = (id) => shop.get(String(id));
  const later = (ms) => { now.value = new Date(now.value.getTime() + ms); };
  const vote = async (option, from = PHONE, pollId = 'OLD') => {
    await service.processWasenderInbound({ event: 'poll.results', data: { key: { id: pollId }, pollResult: [{ name: option, voters: [`${from.slice(1)}@s.whatsapp.net`] }] } }, `vote-${pollId}-${option}`);
    await service.drain();
  };
  return { service, store, shop, get, sent, teamNotices, mails, hdCancels, created, reply, vote, polls, later, now, quietState, send, wooClient, parcels, products };
}

test('three messages per order: a first correction is free, then 3 minutes apart, then the limit', async () => {
  const t = setup([order(10, { meta: SENT() })]);
  assert.deepEqual(await t.service.manageCheck('10', 'updated'), { ok: true, left: 2, lastSentAt: '2026-11-20T09:00:00.000Z', deferred: false });
  assert.equal(t.sent.length, 0, 'check sends nothing');

  const first = await t.service.manageSend('10', 'updated');
  assert.deepEqual({ ok: first.ok, left: first.left, deferred: first.deferred }, { ok: true, left: 1, deferred: false });
  assert.equal(t.sent[0].message, "La commande #10 est mise à jour. Réponds 1 à ce message, l'ancien ne compte plus.\n\nSalam Sara Test #10 Cap x1 Rue 1");
  assert.equal(metaOf(t.get(10), 'rhymat_wa_manage_count'), 2);

  assert.deepEqual(await t.service.manageSend('10', 'resend'), { ok: false, reason: 'cooldown' });
  assert.deepEqual(await t.service.manageSend('10', 'address'), { ok: false, reason: 'cooldown' });

  t.later(3 * MINUTE);
  t.get(10).billing.address_1 = 'Rue 2';
  const second = await t.service.manageSend('10', 'resend');
  assert.equal(second.left, 0);
  assert.equal(t.sent[1].message, 'Salam Sara Test #10 Cap x1 Rue 2', 'a resend is the normal message with fresh data');
  assert.equal(metaOf(t.get(10), 'rhymat_whatsapp_manage_2_state'), 'sent');
  assert.equal(metaOf(t.get(10), 'rhymat_whatsapp_manage_3_state'), 'sent');

  t.later(HOUR);
  assert.deepEqual(await t.service.manageCheck('10', 'updated'), { ok: false, reason: 'limit' });
  assert.deepEqual(await t.service.manageSend('10', 'resend'), { ok: false, reason: 'limit' });
  assert.equal(t.sent.length, 2);
});

test('a resend waits 3 minutes after the first message; a confirmed or unknown order is refused', async () => {
  const t = setup([order(11, { meta: SENT('2026-11-20T09:58:00.000Z') }), order(12, { status: 'on-hold', meta: CONFIRMED })]);
  assert.deepEqual(await t.service.manageSend('11', 'resend'), { ok: false, reason: 'cooldown' });
  assert.deepEqual(await t.service.manageSend('12', 'resend'), { ok: false, reason: 'not_pending' });
  assert.deepEqual(await t.service.manageSend('12', 'replacement'), { ok: false, reason: 'not_changeable' });
  assert.deepEqual(await t.service.manageSend('99', 'resend'), { ok: false, reason: 'not_found' });
  assert.equal(t.sent.length, 0);
});

test('3 customer-triggered messages per phone and day; the shop-wide cap alerts the team once', async () => {
  const t = setup([order(13, { meta: SENT() }), order(14, { meta: SENT() }), order(15, { meta: SENT() }), order(16, { meta: SENT() })]);
  for (const id of ['13', '14', '15']) {
    assert.equal((await t.service.manageSend(id, 'updated')).ok, true);
  }
  assert.deepEqual(await t.service.manageSend('16', 'updated'), { ok: false, reason: 'daily_phone_limit' });
  t.later(24 * HOUR);
  assert.equal((await t.service.manageSend('16', 'updated')).ok, true);

  const shop = setup([order(17, { meta: SENT() }), order(18, { meta: SENT(), phone: '212600000002' }), order(19, { meta: SENT(), phone: '212600000003' })], { shopLimit: 1 });
  assert.equal((await shop.service.manageSend('17', 'updated')).ok, true);
  assert.deepEqual(await shop.service.manageSend('18', 'updated'), { ok: false, reason: 'shop_daily_limit' });
  assert.deepEqual(await shop.service.manageCheck('19', 'updated'), { ok: false, reason: 'shop_daily_limit' });
  await shop.service.drain();
  assert.equal(shop.teamNotices.length, 1);
});

test('a number not on WhatsApp or a failed send never cancels the order and uses nothing', async () => {
  const t = setup([order(20, { meta: SENT() })]);
  t.send.error = new WasenderSendError({ status: 422, data: { message: 'not on whatsapp' }, message: 'refused' });
  assert.deepEqual(await t.service.manageSend('20', 'phone'), { ok: false, reason: 'invalid_number' });
  t.send.error = new WasenderSendError({ status: 500, data: {}, message: 'down' });
  assert.deepEqual(await t.service.manageSend('20', 'phone'), { ok: false, reason: 'send_failed' });
  assert.equal(t.get(20).status, 'processing');
  assert.equal(metaOf(t.get(20), 'rhymat_wa_manage_count'), '');
  assert.equal(metaOf(t.get(20), 'rhymat_wa_number_changed'), '');
  assert.equal(t.mails.length, 0);

  t.send.error = null;
  assert.equal((await t.service.manageSend('20', 'phone')).left, 1);
});

test('a send that cannot leave the queue in time is given up', async () => {
  const t = setup([order(21, { meta: SENT() })]);
  t.service.wasenderClient.sendMessage = async ({ beforeDispatch }) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await beforeDispatch();
    t.sent.push({});
  };
  t.service.manageDispatchBudgetMs = 10;
  assert.deepEqual(await t.service.manageSend('21', 'updated'), { ok: false, reason: 'send_failed' });
  assert.equal(t.sent.length, 0);
  assert.equal(metaOf(t.get(21), 'rhymat_whatsapp_manage_2_state'), '');
});

test('number change: once only, the old number is ignored, the new one (06 form) confirms', async () => {
  const t = setup([order(22, { meta: SENT() })]);
  t.store.upsertOrder({ orderId: '22', phone: PHONE, confirmationState: 'pending_confirmation', rawOrder: t.get(22) });
  t.get(22).billing.phone = '0611111111';
  assert.equal((await t.service.manageSend('22', 'phone')).ok, true);
  assert.equal(t.sent[0].to, '+212611111111');
  assert.equal(metaOf(t.get(22), 'rhymat_wa_number_changed'), 'yes');

  t.later(HOUR);
  assert.deepEqual(await t.service.manageCheck('22', 'phone'), { ok: false, reason: 'number_already_changed' });

  await t.reply('2', PHONE);
  assert.equal(t.get(22).status, 'processing');
  // A cache that still knows the old number is refused inside the lock too.
  t.store.upsertOrder({ orderId: '22', phone: PHONE, confirmationState: 'pending_confirmation' });
  await t.reply('2', PHONE);
  assert.equal(t.get(22).status, 'processing');
  assert.equal(t.sent.length, 1, 'nothing more goes to the old number');

  await t.reply('1', '+212611111111');
  assert.equal(metaOf(t.get(22), 'rhymat_whatsapp_decision'), 'confirmed');
  assert.equal(t.sent[1].to, '+212611111111');
});

test('the direct link token follows the contract', () => {
  const t = setup([]);
  const exp = Math.floor(t.now.value.getTime() / 1000) + 45 * 24 * 60 * 60;
  const mac = createHmac('sha256', 'task-secret').update(`rhymat-manage:10:${exp}`).digest('hex').slice(0, 32);
  assert.equal(t.service.manageLink('10'), `https://rhymat.ma/suivi/?n=10&k=${exp.toString(36)}-${mac}`);
});

test('the order webhook and the hourly backfill never start a replacement order', async () => {
  const t = setup([replacement(31, 30)]);
  const result = await t.service.processWooOrder(clone(t.get(31)), 'delivery-31');
  assert.equal(result.body.reason, 'replacement_order');
  await t.service.runOrderFollowups({ now: new Date(t.now.value.getTime() + HOUR) });
  assert.equal(t.sent.length, 0);
});

test('replacement: check on the old order, send on the new one, counters on both', async () => {
  const t = setup([confirmedOld(30, ''), replacement(31, 30)]);
  assert.deepEqual(await t.service.manageCheck('30', 'replacement'), { ok: true, left: 2, lastSentAt: '2026-11-20T09:00:00.000Z', deferred: false });
  t.get(30).meta_data.find((row) => row.key === 'rhymat_replacement_pending').value = '31';
  const result = await t.service.manageSend('31', 'replacement');
  assert.deepEqual({ ok: result.ok, left: result.left }, { ok: true, left: 1 });
  assert.ok(t.sent[0].message.startsWith('La commande #30 sera annulée et remplacée par la #31. Réponds 1 pour valider. Sans réponse, la #30 reste.\n\nSalam'));
  assert.equal(metaOf(t.get(31), 'rhymat_wa_manage_count'), 2);
  assert.equal(metaOf(t.get(30), 'rhymat_wa_manage_count'), 2);
  assert.equal(metaOf(t.get(31), 'rhymat_whatsapp_state'), 'pending');
  assert.equal(t.get(30).status, 'on-hold', 'the old order waits for the answer');

  // A resend asked for the old order resends the replacement.
  t.later(3 * MINUTE);
  assert.equal((await t.service.manageSend('30', 'resend')).left, 0);
  assert.ok(t.sent[1].message.startsWith('La commande #30 sera annulée'));
});

test('replacement of a collected parcel is not changeable', async () => {
  const t = setup([confirmedOld(30, '', PARCEL)], { parcels: [{ id: 7, tracking_number: 'HD-1', status: 'picked_up' }] });
  assert.deepEqual(await t.service.manageCheck('30', 'replacement'), { ok: false, reason: 'not_changeable' });
});

test('reply 1 on a replacement: parcel then old order cancelled silently, new one confirmed and sent', async () => {
  // Confirmed a moment ago: the "1" for the replacement is not read as a repeat of that answer.
  const t = setup([confirmedOld(30, 31, PARCEL), waitingReplacement(31, 30)], { parcels: [{ id: 7, tracking_number: 'HD-1', status: 'created' }], trust: 5 });
  t.store.upsertOrder({ orderId: '30', phone: PHONE, confirmationState: 'confirmed', decision: 'confirmed', decisionAt: new Date().toISOString() });
  t.store.upsertOrder({ orderId: '31', phone: PHONE, confirmationState: 'pending_confirmation', rawOrder: clone(t.get(31)), manageLastAt: new Date(Date.now() + 1000).toISOString() });

  await t.reply('1');

  assert.deepEqual(t.hdCancels, [7]);
  assert.equal(t.get(30).status, 'cancelled');
  assert.equal(metaOf(t.get(30), 'rhymat_replaced_by'), '31');
  assert.equal(metaOf(t.get(30), 'rhymat_replacement_pending'), '');
  assert.equal(t.mails.length, 0);
  assert.equal(t.sent.length, 1, 'one reply, no cancel message');
  assert.match(t.sent[0].message, /Numero dyal la commande: 31/u);
  assert.match(t.sent[0].message, /https:\/\/rhymat\.ma\/suivi\/\?n=31&k=[0-9a-z]+-[0-9a-f]{32}/u);
  assert.equal(metaOf(t.get(31), 'rhymat_whatsapp_decision'), 'confirmed');
  assert.equal(t.created.length, 1, 'the low score left by the cancelled parcel does not hold the replacement');
  assert.equal(t.get(31).status, 'completed');

  // Our own cancel coming back through the order webhook is not a manual change.
  const echo = await t.service.processWooOrder(clone(t.get(30)), 'delivery-30');
  assert.equal(echo.body.reason, 'own_status_change');
  assert.equal(metaOf(t.get(30), 'rhymat_whatsapp_manual_override'), '');
});

test('reply 2 on a replacement cancels only the new order', async () => {
  const t = setup([confirmedOld(30, 31, PARCEL), waitingReplacement(31, 30)]);
  await t.reply('2');
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(t.get(30).status, 'on-hold');
  assert.equal(metaOf(t.get(30), 'rhymat_replacement_pending'), '');
  assert.deepEqual(t.sent.map((item) => item.message), ['La commande #30 reste comme avant.']);
  assert.deepEqual(t.hdCancels, []);
});

test('reply 1 too late: the parcel was collected, only the new order is cancelled', async () => {
  const t = setup([confirmedOld(30, 31, PARCEL), waitingReplacement(31, 30)], { parcels: [{ id: 7, tracking_number: 'HD-1', status: 'picked_up' }] });
  await t.reply('1');
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(t.get(30).status, 'on-hold');
  assert.deepEqual(t.sent.map((item) => item.message), ["Trop tard : la commande #30 est déjà partie, rien n'a changé."]);
  assert.deepEqual(t.hdCancels, []);
  assert.equal(t.created.length, 0);
});

test('a "too late" answer given at night is sent in the morning with its own text', async () => {
  const t = setup([confirmedOld(30, 31, PARCEL), waitingReplacement(31, 30)], { parcels: [{ id: 7, tracking_number: 'HD-1', status: 'picked_up' }], quietNow: true });
  await t.reply('1');
  assert.equal(t.sent.length, 0);
  t.quietState.on = false;
  await t.service.runOrderFollowups({ now: new Date() });
  assert.deepEqual(t.sent.map((item) => item.message), ["Trop tard : la commande #30 est déjà partie, rien n'a changé."]);
});

test('reply 1 when HighDelivery refuses the cancel: the old order stays and the team is told', async () => {
  const t = setup([confirmedOld(30, 31, PARCEL), waitingReplacement(31, 30)], {
    parcels: [{ id: 7, tracking_number: 'HD-1', status: 'created' }],
    cancelParcel: () => { throw new HighDeliveryError('nope', { status: 400 }); }
  });
  await t.reply('1');
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(t.get(30).status, 'on-hold');
  assert.deepEqual(t.sent.map((item) => item.message), ["La modification n'a pas pu se faire, la commande #30 reste comme avant."]);
  assert.equal(t.created.length, 0);
  assert.ok(t.teamNotices.some((text) => text.includes('30')));
});

test('reply 1 when the old order was already cancelled cancels the new one too', async () => {
  const t = setup([order(30, { status: 'cancelled', meta: { ...CONFIRMED, rhymat_replacement_pending: '31' } }), waitingReplacement(31, 30)]);
  await t.reply('1');
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(t.sent.length, 0);
});

test('a replacement gets no reminder and expires silently after 72 hours', async () => {
  const t = setup([confirmedOld(30, 31), waitingReplacement(31, 30)]);
  await t.service.runOrderFollowups({ now: new Date(t.now.value.getTime() + 49 * HOUR) });
  assert.equal(t.get(31).status, 'processing');
  const summary = await t.service.runOrderFollowups({ now: new Date(t.now.value.getTime() + 73 * HOUR) });
  assert.equal(summary.autoCancelled, 1);
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(t.get(30).status, 'on-hold');
  assert.equal(metaOf(t.get(30), 'rhymat_replacement_pending'), '');
  assert.equal(t.sent.length, 0);
});

test('no auto-cancel within a day of a message the customer asked for', async () => {
  const t = setup([order(23, {
    meta: { ...SENT('2026-11-17T09:00:00.000Z'), rhymat_whatsapp_reminder_count: 2, rhymat_whatsapp_reminder_2_sent_at: '2026-11-19T09:00:00.000Z', rhymat_wa_manage_count: 2, rhymat_wa_manage_last_at: '2026-11-20T09:30:00.000Z' }
  })]);
  await t.service.runOrderFollowups({ now: t.now.value });
  assert.equal(t.get(23).status, 'processing');
  assert.equal(t.sent.length, 0);
});

test('quiet hours hold the message; the hourly task sends it once in the morning', async () => {
  const t = setup([order(24, { meta: SENT() })], { quietNow: true });
  const result = await t.service.manageSend('24', 'updated');
  assert.deepEqual({ ok: result.ok, left: result.left, deferred: result.deferred }, { ok: true, left: 1, deferred: true });
  assert.equal(t.sent.length, 0);
  // Another change in the same night replaces the held message and is not counted twice.
  t.later(5 * MINUTE);
  assert.equal((await t.service.manageSend('24', 'address')).left, 1);

  t.quietState.on = false;
  t.later(8 * HOUR);
  await t.service.runOrderFollowups({ now: t.now.value });
  await t.service.runOrderFollowups({ now: t.now.value });
  assert.equal(t.sent.length, 1);
  assert.ok(t.sent[0].message.startsWith('La commande #24 est mise à jour.'));
  assert.equal(metaOf(t.get(24), 'rhymat_wa_manage_deferred'), '');
  assert.equal(metaOf(t.get(24), 'rhymat_wa_manage_count'), 2);
});

test('cancel: parcel first, then the order and its waiting replacement, no customer message', async () => {
  const t = setup([confirmedOld(30, 31, PARCEL), waitingReplacement(31, 30)], { parcels: [{ id: 7, tracking_number: 'HD-1', status: 'pickup_pending' }] });
  assert.deepEqual(await t.service.manageCancel('30', 'Erreur'), { ok: true });
  await t.service.drain();
  assert.deepEqual(t.hdCancels, [7]);
  assert.equal(t.get(30).status, 'cancelled');
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(metaOf(t.get(30), 'rhymat_replacement_pending'), '');
  assert.equal(t.sent.length, 0);
  assert.equal(t.mails.length, 0);
  const echo = await t.service.processWooOrder(clone(t.get(30)), 'delivery-cancel-30');
  assert.equal(echo.body.reason, 'own_status_change');
});

test('cancel is refused when collected or when the parcel cannot be verified or cancelled', async () => {
  const collected = setup([order(40, { status: 'completed', meta: { ...CONFIRMED, ...PARCEL } })], { parcels: [{ id: 7, tracking_number: 'HD-1', status: 'in_transit' }] });
  assert.deepEqual(await collected.service.manageCancel('40'), { ok: false, reason: 'too_late' });

  const failing = setup([order(41, { status: 'completed', meta: { ...CONFIRMED, ...PARCEL } })], {
    parcels: [{ id: 7, tracking_number: 'HD-1', status: 'created' }],
    cancelParcel: () => { throw new HighDeliveryError('no answer', { ambiguous: true }); }
  });
  assert.deepEqual(await failing.service.manageCancel('41'), { ok: false, reason: 'hd_cancel_failed' });

  const untraced = setup([order(42, { status: 'completed', meta: CONFIRMED })]);
  assert.deepEqual(await untraced.service.manageCancel('42'), { ok: false, reason: 'hd_cancel_failed' });

  const sending = setup([order(43, { status: 'on-hold', meta: { ...CONFIRMED, rhymat_hd_api_state: 'unknown' } })]);
  assert.deepEqual(await sending.service.manageCancel('43'), { ok: false, reason: 'hd_cancel_failed' });

  for (const [t, id] of [[collected, 40], [failing, 41], [untraced, 42], [sending, 43]]) {
    assert.notEqual(t.get(id).status, 'cancelled');
    assert.equal(t.sent.length, 0);
  }
});

test('a cancel waits for an auto-send that is creating the parcel, then cancels that parcel', async () => {
  const t = setup([order(44, { status: 'on-hold', meta: CONFIRMED })]);
  const hdClient = t.service.hdAutoSend.hdClient;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  hdClient.createPackage = async () => {
    await gate;
    t.parcels.push({ id: 9, tracking_number: 'HD-9', status: 'created' });
    return { trackingNumber: 'HD-9' };
  };
  const sending = t.service.hdAutoSend.autoSend({ orderId: '44' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelling = t.service.manageCancel('44');
  release();
  assert.deepEqual(await cancelling, { ok: true });
  await sending;
  assert.deepEqual(t.hdCancels, [9]);
  assert.equal(t.get(44).status, 'cancelled');
});

test('the answer goes to the order the customer was asked about last, not the newest one', async () => {
  const t = setup([
    order(70, { meta: { ...SENT(), rhymat_wa_manage_count: 2, rhymat_wa_manage_last_at: '2026-11-20T09:50:00.000Z' } }),
    order(71, { meta: SENT('2026-11-20T09:30:00.000Z'), created: '2026-11-20T09:29:00' })
  ]);
  await t.reply('2');
  assert.equal(t.get(70).status, 'cancelled');
  assert.equal(t.get(71).status, 'processing');
});

test('a replacement held overnight is sent in the morning, with both orders counted', async () => {
  const t = setup([confirmedOld(30, 31), replacement(31, 30)], { quietNow: true });
  const result = await t.service.manageSend('31', 'replacement');
  assert.equal(result.deferred, true);
  assert.equal(t.sent.length, 0);
  assert.equal(metaOf(t.get(30), 'rhymat_wa_manage_count'), 2);

  t.quietState.on = false;
  t.later(8 * HOUR);
  await t.service.runOrderFollowups({ now: t.now.value });
  assert.equal(t.sent.length, 1);
  assert.ok(t.sent[0].message.startsWith('La commande #30 sera annulée'));
  assert.equal(metaOf(t.get(31), 'rhymat_whatsapp_state'), 'pending');
});

test('drop-replacement cancels only the waiting replacement', async () => {
  const t = setup([confirmedOld(30, 31), waitingReplacement(31, 30), order(50, { status: 'on-hold', meta: CONFIRMED })]);
  assert.deepEqual(await t.service.manageDropReplacement('30'), { ok: true });
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(t.get(30).status, 'on-hold');
  assert.deepEqual(await t.service.manageDropReplacement('30'), { ok: false, reason: 'no_replacement' });
  assert.deepEqual(await t.service.manageDropReplacement('50'), { ok: false, reason: 'no_replacement' });
  // A pointer to an order that does not name this one is never cancelled.
  t.get(50).meta_data.push({ key: 'rhymat_replacement_pending', value: '30' });
  assert.deepEqual(await t.service.manageDropReplacement('50'), { ok: false, reason: 'no_replacement' });
  assert.equal(t.get(30).status, 'on-hold');
  assert.equal(t.sent.length, 0);
});

test('the /tasks/manage routes need the task secret and answer refusals with HTTP 200', async () => {
  const t = setup([order(60, { status: 'on-hold', meta: CONFIRMED })]);
  const app = createApp({ config: { tasks: { secret: 'task-secret' } }, confirmationService: t.service, store: t.store, logger: quiet });
  const call = async (action, body, secret = 'task-secret') => {
    const listeners = {};
    const raw = JSON.stringify(body);
    const req = {
      method: 'POST',
      url: `/tasks/manage/${action}`,
      headers: { 'x-task-secret': secret },
      on(event, callback) {
        listeners[event] = callback;
        if (event === 'data') { callback(raw); }
        if (event === 'end') { callback(); }
      }
    };
    const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await app(req, res);
    return [res.status, res.body];
  };
  assert.equal((await call('check', { orderId: 60, kind: 'resend' }, 'wrong'))[0], 401);
  assert.deepEqual(await call('check', { orderId: 60, kind: 'resend' }), [200, { ok: false, reason: 'not_pending' }]);
  assert.deepEqual(await call('send', { orderId: '60', kind: 'nope' }), [400, { ok: false, reason: 'bad_request' }]);
  assert.deepEqual(await call('cancel', { orderId: '../1' }), [400, { ok: false, reason: 'bad_request' }]);
  assert.deepEqual(await call('drop-replacement', { orderId: 60 }), [200, { ok: false, reason: 'no_replacement' }]);
  assert.deepEqual(await call('cancel', { orderId: 60, reason: 'Autre' }), [200, { ok: true }]);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a Moroccan local number is sent to as +212, never cancelled as an invalid phone', async () => {
  const t = setup([order(80, { phone: '0612345678' })]);
  await t.service.processWooOrder(clone(t.get(80)), 'delivery-80');
  assert.equal(t.get(80).status, 'processing');
  assert.equal(t.sent[0].to, '+212612345678');
  assert.equal(t.mails.length, 0);
});

test('an accepted check holds the parcel while the website changes the order, then it goes with the fresh data', async () => {
  const t = setup([order(81, { meta: SENT() })], { holdMs: 150 });
  assert.equal((await t.service.manageCheck('81', 'address')).ok, true);
  assert.equal(t.sent.length, 0);
  t.get(81).billing.address_1 = 'Half changed';
  await t.reply('1');
  assert.equal(metaOf(t.get(81), 'rhymat_whatsapp_decision'), 'confirmed');
  assert.equal(t.created.length, 0, 'no parcel during the hold');
  assert.match(metaOf(t.get(81), 'rhymat_wa_manage_hold_until'), /\|send$/u);

  // The website's send is refused and it undoes its change.
  assert.deepEqual(await t.service.manageSend('81', 'address'), { ok: false, reason: 'not_pending' });
  t.get(81).billing.address_1 = 'Rue 1';
  await wait(500);
  await t.service.drain();
  assert.equal(t.created.length, 1);
  assert.equal(t.created[0].address, 'Rue 1');
  assert.equal(metaOf(t.get(81), 'rhymat_wa_manage_hold_until'), '');
});

test('a successful send releases the hold; a lost retry timer is picked up by the hourly task', async () => {
  const t = setup([order(82, { meta: SENT() })]);
  await t.service.manageCheck('82', 'updated');
  assert.ok(metaOf(t.get(82), 'rhymat_wa_manage_hold_until'));
  await t.service.manageSend('82', 'updated');
  assert.equal(metaOf(t.get(82), 'rhymat_wa_manage_hold_until'), '');
  await t.reply('1');
  assert.equal(t.created.length, 1);

  const restarted = setup([order(83, { status: 'on-hold', meta: { ...CONFIRMED, rhymat_wa_manage_hold_until: '2026-11-20T08:00:00.000Z|send' } })]);
  await restarted.service.runOrderFollowups({ now: restarted.now.value });
  await restarted.service.drain();
  await restarted.service.runOrderFollowups({ now: restarted.now.value });
  await restarted.service.drain();
  assert.equal(restarted.created.length, 1);
});

test('a replacement check holds the old order too, and its send releases it', async () => {
  const t = setup([confirmedOld(30, ''), replacement(31, 30)]);
  await t.service.manageCheck('30', 'replacement');
  assert.equal((await t.service.hdAutoSend.autoSend({ orderId: '30' })).reason, 'edit_in_progress');
  await t.service.manageSend('31', 'replacement');
  assert.notEqual((await t.service.hdAutoSend.autoSend({ orderId: '30' })).reason, 'edit_in_progress');
});

test('an order handled by hand is refused everywhere, and an on-hold order without confirmation is not replaced', async () => {
  const hand = { ...CONFIRMED, rhymat_whatsapp_manual_override: 'yes' };
  const t = setup([
    order(84, { status: 'on-hold', meta: { ...hand, rhymat_replacement_pending: '85' } }),
    replacement(85, 84, { rhymat_whatsapp_manual_override: 'yes' }),
    order(86, { status: 'on-hold', meta: SENT() }),
    order(87, { status: 'confirmed' }),
    order(88, { meta: { ...SENT(), rhymat_whatsapp_manual_override: 'yes' } })
  ]);
  for (const [id, kind] of [['84', 'replacement'], ['85', 'replacement'], ['88', 'updated'], ['88', 'resend']]) {
    assert.deepEqual(await t.service.manageSend(id, kind), { ok: false, reason: 'not_changeable' });
  }
  assert.deepEqual(await t.service.manageCheck('86', 'replacement'), { ok: false, reason: 'not_changeable' });
  assert.equal((await t.service.manageCheck('87', 'replacement')).ok, true, 'the team set "confirmed"');
  for (const id of ['84', '86', '88']) {
    assert.deepEqual(await t.service.manageCancel(id), { ok: false, reason: 'not_changeable' });
    assert.deepEqual(await t.service.manageCancel(id), { ok: false, reason: 'not_changeable' });
  }
  assert.deepEqual(await t.service.manageDropReplacement('84'), { ok: false, reason: 'not_changeable' });
  await t.service.drain();
  assert.equal(t.teamNotices.length, 3, 'one notice per order');
  assert.equal(t.sent.length, 0);
  assert.equal(t.get(85).status, 'processing');
  assert.equal(t.get(86).status, 'on-hold');
});

test('reply 1 on a replacement of an order that went on hold by hand keeps the old order', async () => {
  const t = setup([order(30, { status: 'on-hold', meta: { ...CONFIRMED, rhymat_whatsapp_manual_override: 'yes', rhymat_replacement_pending: '31' } }), waitingReplacement(31, 30)]);
  await t.reply('1');
  assert.equal(t.get(30).status, 'on-hold');
  assert.equal(t.get(31).status, 'cancelled');
});

test('an abandoned replacement is cancelled silently after 30 minutes, never one with a send record', async () => {
  const t = setup([
    confirmedOld(30, 31),
    order(31, { meta: { rhymat_replaces: '30', rhymat_wa_manage_count: 1 }, created: '2026-11-20T09:45:00' }),
    confirmedOld(40, 41),
    order(41, { meta: { rhymat_replaces: '40', rhymat_whatsapp_confirmation_request_state: 'reserved', rhymat_whatsapp_confirmation_request_reserved_at: '2026-11-20T09:50:00.000Z' }, created: '2026-11-20T09:00:00' })
  ]);
  t.get(31).date_created_gmt = new Date(t.now.value.getTime() - 10 * MINUTE).toISOString().slice(0, 19);
  await t.service.runOrderFollowups({ now: t.now.value });
  assert.equal(t.get(31).status, 'processing', 'only 10 minutes old');
  await t.service.runOrderFollowups({ now: new Date(t.now.value.getTime() + 25 * MINUTE) });
  assert.equal(t.get(31).status, 'cancelled');
  assert.equal(metaOf(t.get(30), 'rhymat_replacement_pending'), '');
  assert.equal(t.get(30).status, 'on-hold');
  assert.equal(t.get(41).status, 'processing');
  assert.equal(t.sent.length, 0);
});

const stockedOrders = ({ stock, held }) => {
  const old = confirmedOld(30, 31, PARCEL);
  old.line_items = [{ name: 'Hoodie M', product_id: 5, variation_id: 51, quantity: 1, meta_data: held ? [{ key: '_reduced_stock', value: held }] : [] }];
  const next = waitingReplacement(31, 30);
  next.line_items = [{ name: 'Hoodie M', product_id: 5, variation_id: 51, quantity: 1 }, { name: 'Cap', product_id: 6, variation_id: 0, quantity: 1 }];
  return setup([old, next], {
    parcels: [{ id: 7, tracking_number: 'HD-1', status: 'created' }],
    products: {
      5: { id: 5, manage_stock: false, variations: [{ id: 51, manage_stock: true, stock_quantity: 0, backorders: 'no' }] },
      6: { id: 6, manage_stock: true, stock_quantity: stock, backorders: 'no' }
    }
  });
};

test('the swap needs the stock: short means the old order and its parcel stay', async () => {
  const short = stockedOrders({ stock: 0, held: 1 });
  await short.reply('1');
  assert.equal(short.get(30).status, 'on-hold');
  assert.equal(short.get(31).status, 'cancelled');
  assert.deepEqual(short.hdCancels, []);
  assert.deepEqual(short.sent.map((item) => item.message), ["La modification n'a pas pu se faire, la commande #30 reste comme avant."]);
  assert.ok(short.teamNotices.some((text) => text.includes('stock')));

  // The piece the old order holds comes back on cancel, so it counts.
  const enough = stockedOrders({ stock: 1, held: 1 });
  await enough.reply('1');
  assert.equal(enough.get(30).status, 'cancelled');
  assert.equal(metaOf(enough.get(31), 'rhymat_whatsapp_decision'), 'confirmed');

  const notHeld = stockedOrders({ stock: 1, held: 0 });
  await notHeld.reply('1');
  assert.equal(notHeld.get(30).status, 'on-hold');
});

test('the stock sync reserves nothing for a waiting replacement', () => {
  const resolve = () => [{ hdId: 1, quantity: 1 }];
  const waiting = replacement(31, 30);
  const confirmed = order(32, { status: 'on-hold', meta: { ...CONFIRMED, rhymat_replaces: '29' } });
  assert.equal(computeReservations([waiting, confirmed, order(33)], resolve).get(1), 2);
});

test('a double order the customer changed on the website is not cancelled with its twin', async () => {
  const older = order(90, { meta: { ...SENT('2026-11-16T09:00:00.000Z'), rhymat_wa_manage_last_at: '2026-11-16T10:00:00.000Z', rhymat_wa_manage_count: 2 }, created: '2026-11-16T08:00:00' });
  const newer = order(91, {
    meta: { ...SENT('2026-11-16T09:30:00.000Z'), rhymat_whatsapp_reminder_count: 2, rhymat_whatsapp_reminder_2_sent_at: '2026-11-18T09:30:00.000Z' },
    created: '2026-11-16T09:00:00'
  });
  const t = setup([older, newer]);
  const summary = await t.service.runOrderFollowups({ now: t.now.value });
  assert.equal(summary.autoCancelled, 1);
  assert.equal(t.get(91).status, 'cancelled');
  assert.equal(t.get(90).status, 'processing');
});

test('manage messages carry no poll, and a vote on an older poll then confirms nothing', async () => {
  const t = setup([order(92, { meta: SENT() })], { poll: true });
  await t.service.manageSend('92', 'updated');
  await t.service.drain();
  assert.equal(t.polls.length, 0);
  await t.vote('Confirmer');
  assert.equal(t.get(92).status, 'processing');
  await t.reply('1');
  assert.equal(metaOf(t.get(92), 'rhymat_whatsapp_decision'), 'confirmed');
});

// The website reads these when the answer to /send is lost: one must have changed before the provider is called.
test('every send kind writes a send record to the order before the provider call', async () => {
  const keys = ['rhymat_wa_manage_count', 'rhymat_wa_manage_last_at', 'rhymat_wa_manage_deferred', 'rhymat_whatsapp_manage_2_state', 'rhymat_whatsapp_manage_3_state', 'rhymat_whatsapp_confirmation_request_state'];
  const cases = [
    ['resend', 93, order(93, { meta: SENT() })],
    ['updated', 94, order(94, { meta: SENT() })],
    ['updated', 95, order(95)],
    ['phone', 96, order(96)],
    ['address', 97, order(97, { meta: { ...SENT(), rhymat_wa_manage_count: 2, rhymat_whatsapp_manage_2_state: 'sent' } })],
    ['replacement', 31, replacement(31, 30)],
    // A reservation left by a send that never left the queue is taken over.
    ['updated', 98, order(98, { meta: { ...SENT(), rhymat_whatsapp_manage_2_state: 'reserved', rhymat_whatsapp_manage_2_reserved_at: '2026-11-20T09:00:00.000Z', rhymat_whatsapp_manage_2_dispatched_at: 'queued' } })]
  ];
  for (const [kind, id, item] of cases) {
    const t = setup(kind === 'replacement' ? [confirmedOld(30, 31), item] : [item]);
    const marks = () => keys.map((key) => String(metaOf(t.get(id), key)));
    const before = marks();
    let atCall = null;
    t.send.before = () => { atCall ??= marks(); };
    assert.equal((await t.service.manageSend(String(id), kind)).ok, true, `${kind} ${id}`);
    assert.notDeepEqual(atCall, before, `${kind} ${id}`);
  }
});
