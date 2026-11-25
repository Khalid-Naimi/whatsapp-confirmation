// An order held back from HighDelivery: the team gets the reason and a poll, and its vote (or typed answer) sends it.
// Also the evening count of delivered parcels. Fakes only: nothing is sent anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { DeliveredDigestService } from '../src/services/delivered-digest-service.js';
import { HdAutoSendService } from '../src/services/hd-auto-send-service.js';
import { extractWasenderInboundMessages } from '../src/services/confirmation/inbound/wasender-parser.js';
import { hdReasonInFrench } from '../src/utils/hd-reason.js';
import { parseTeamPollOption, parseTeamText, teamSendOptions } from '../src/utils/team-send.js';

const quiet = { log() {}, warn() {}, error() {} };
const TEAM = ['+212611111111', '+491700000000'];

const wooOrder = (extra = {}) => ({
  id: 901,
  status: 'on-hold',
  total: '399',
  currency: 'MAD',
  billing: { first_name: 'Jane', last_name: 'Doe', phone: '0612345678', city: 'Rabat', address_1: 'Rue 1' },
  line_items: [{ name: 'Hoodie M', quantity: 1 }],
  meta_data: [],
  ...extra
});

function autoSend({ order = wooOrder(), score = 10, create = null } = {}) {
  const sent = [];
  const polls = [];
  const created = [];
  const service = new HdAutoSendService({
    claimSettleMs: 0,
    hdClient: {
      isConfigured: () => true,
      trustScore: async () => ({ score, blacklisted: false, totalOrders: 4, deliveredOrders: 1, failedOrders: 3 }),
      createPackage: create || (async (parcel) => { created.push(parcel); return { trackingNumber: 'NAI1' }; })
    },
    wooClient: { getOrder: async () => order, updateOrderMeta: async () => ({}), addOrderNote: async () => ({}), updateOrderStatus: async () => ({}) },
    wasenderClient: {
      sendMessage: async (payload) => { sent.push(payload); return {}; },
      sendPoll: async (payload) => { polls.push(payload); return {}; }
    },
    store: { appendMessage() {}, upsertOrder() {} },
    notifyPhones: TEAM,
    template: 'SENT {{orderId}}',
    manualTemplate: 'MANUAL {{orderId}} {{problem}}',
    errorTemplate: 'ERROR {{orderId}} {{problem}}',
    enabled: true,
    minTrustScore: 30,
    logger: quiet
  });
  return { service, sent, polls, created };
}

test('a held order tells the team why, in French, and asks with a poll', async () => {
  const { service, sent, polls } = autoSend();
  await service.autoSend({ orderId: '901' });
  assert.equal(sent[0].message, 'MANUAL 901 numero a risque : score 10, minimum 30 (4 colis, 1 livres, 3 echecs)');
  assert.deepEqual(polls.map((poll) => poll.to), TEAM);
  assert.deepEqual(polls[0].options, ['1 - Envoyer #901', '0 - Ne pas envoyer #901']);
});

test('the team yes sends a low-score order; without it nothing is created', async () => {
  const { service, created } = autoSend();
  assert.equal((await service.autoSend({ orderId: '901' })).status, 'held');
  assert.equal(created.length, 0);
  assert.equal((await service.autoSend({ orderId: '901' }, { force: true })).status, 'sent');
  assert.equal(created.length, 1);
});

test('a blacklisted number is never sent by a vote and gets no poll', async () => {
  const { service, polls, created } = autoSend();
  service.hdClient.trustScore = async () => ({ score: 0, blacklisted: true, totalOrders: 4, deliveredOrders: 0, failedOrders: 4 });
  assert.equal((await service.autoSend({ orderId: '901' }, { force: true })).status, 'held');
  assert.equal(created.length, 0);
  assert.equal(polls.length, 0);
});

test('voting again later counts, the same webhook twice does not', () => {
  const key = (timestamp) => extractWasenderInboundMessages(
    { event: 'poll.results', timestamp, data: { key: { id: 'p1', fromMe: true }, pollResult: [{ name: '1 - Envoyer #901', voters: ['212611111111@s.whatsapp.net'] }] } }, 'e', quiet
  )[0].messageKey;
  assert.equal(key(1000), key(1000));
  assert.notEqual(key(1000), key(2000));
});

test('no poll when the parcel may already exist', async () => {
  const lost = Object.assign(new Error('timeout'), { ambiguous: true });
  const { service, polls } = autoSend({ score: 80, create: async () => { throw lost; } });
  assert.equal((await service.autoSend({ orderId: '901' })).status, 'unknown');
  assert.equal(polls.length, 0);
});

test('reasons are in French and an unknown one is kept as written', () => {
  assert.equal(
    hdReasonInFrench('the address is missing; not enough "Cap" in the HighDelivery warehouse (0 available, 2 needed)'),
    'adresse manquante; stock insuffisant chez High Delivery : "Cap" (disponible 0, demande 2)'
  );
  assert.equal(hdReasonInFrench('no HighDelivery product is mapped to "Tee - L"'), '"Tee - L" : pas relie a un produit High Delivery (ouvrir Matching)');
  assert.equal(hdReasonInFrench('"HD Tee L" (for "Tee - L") is not in the HighDelivery warehouse'), '"Tee - L" : "HD Tee L" n\'existe pas dans le stock High Delivery');
  assert.equal(hdReasonInFrench('something new'), 'something new');
});

test('only the exact team answers are read', () => {
  const [yes, no] = teamSendOptions('901');
  assert.deepEqual(parseTeamPollOption(yes), { orderId: '901', send: true });
  assert.deepEqual(parseTeamPollOption(no), { orderId: '901', send: false });
  assert.equal(parseTeamPollOption('Confirmer'), null);
  assert.equal(parseTeamPollOption('0 - Envoyer #901'), null);
  assert.deepEqual(parseTeamText(' Envoyer #901 '), { orderId: '901', send: true });
  assert.deepEqual(parseTeamText('ne pas envoyer 901'), { orderId: '901', send: false });
  assert.equal(parseTeamText('envoyer 901 demain'), null);
  assert.equal(parseTeamText('1'), null);
});

function service({ order = wooOrder(), outcome = { status: 'sent' } } = {}) {
  const sends = [];
  const asked = [];
  const notes = [];
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-send-')), 'db.json'), { logger: quiet });
  const confirmationService = new ConfirmationService({
    store,
    wasenderClient: { async sendMessage(payload) { sends.push(payload); return {}; } },
    wooClient: { async getOrder() { return structuredClone(order); }, async addOrderNote(id, note) { notes.push(note); return {}; } },
    hdAutoSend: { enabled: true, async autoSend(sentOrder, options) { asked.push([sentOrder.orderId, options]); return outcome; } },
    messages: { internalNotifyPhones: TEAM, defaultCityLabel: 'Maroc' },
    claimSettleMs: 0,
    logger: quiet
  });
  const vote = async (name, from = TEAM[0]) => {
    const [message] = extractWasenderInboundMessages(
      { event: 'poll.results', data: { key: { id: 'p1', fromMe: true }, pollResult: [{ name, voters: [`${from.slice(1)}@s.whatsapp.net`] }] } }, name, quiet
    );
    const result = await confirmationService.routeInboundMessage(message);
    await confirmationService.drain();
    return result;
  };
  const type = async (text, from = TEAM[1]) => {
    const [message] = extractWasenderInboundMessages({ data: { messages: { key: { id: text, cleanedSenderPn: from.slice(1), fromMe: false }, messageBody: text } } }, text, quiet);
    const result = confirmationService.routeTeamAnswer(message);
    await confirmationService.drain();
    return result;
  };
  return { vote, type, asked, sends, notes };
}

test('a team vote of 1 sends the order, 0 does not', async () => {
  const yes = service();
  assert.equal((await yes.vote('1 - Envoyer #901')).route, 'team');
  assert.equal(yes.asked.length, 1);
  assert.equal(String(yes.asked[0][0]), '901');
  assert.deepEqual(yes.asked[0][1], { force: true });

  const no = service();
  await no.vote('0 - Ne pas envoyer #901');
  assert.equal(no.asked.length, 0);
  assert.deepEqual(no.sends.map((send) => send.message), ['OK, commande #901 non envoyee.']);
});

test('the typed answer works too, and only from a team phone', async () => {
  const team = service();
  await team.type('envoyer 901');
  assert.equal(team.asked.length, 1);

  const stranger = service();
  assert.equal(await stranger.type('envoyer 901', '+212699999999'), null);
  assert.equal((await stranger.vote('1 - Envoyer #901', '+212699999999')).ignored, true);
  assert.equal(stranger.asked.length, 0);
  assert.equal(stranger.sends.length, 0);
});

test('a cancelled order is never sent, and the team is told why', async () => {
  const t = service({ order: wooOrder({ status: 'cancelled' }) });
  await t.vote('1 - Envoyer #901');
  assert.equal(t.asked.length, 0);
  assert.match(t.sends[0].message, /non envoyee : son statut est "cancelled"/u);
});

test('an order that is already sent gets a short answer', async () => {
  const t = service({ outcome: { status: 'skipped', reason: 'already_sent' } });
  await t.vote('1 - Envoyer #901');
  assert.deepEqual(t.sends.map((send) => send.message), ['Commande #901 : elle est deja envoyee.']);
});

function digest({ parcels, at }) {
  const alerts = [];
  const instance = new DeliveredDigestService({
    hdClient: { isConfigured: () => true, listPackages: async () => parcels },
    alert: async (alert) => { alerts.push(alert); return { delivered: true }; },
    now: () => new Date(at),
    logger: quiet
  });
  return { instance, alerts };
}

test('the evening count: only parcels delivered today, nothing before 21:00 or when there are none', async () => {
  const parcels = [
    { status: 'delivered', delivered_at: '2026-11-25T09:00:00Z' },
    { status: 'delivered', delivered_at: '2026-11-25T15:00:00Z' },
    { status: 'delivered', delivered_at: '2026-11-24T15:00:00Z' },
    { status: 'in_transit', delivered_at: null },
    { status: 'delivered' }
  ];
  // Morocco is one hour ahead of UTC.
  const evening = digest({ parcels, at: '2026-11-25T20:05:00Z' });
  assert.equal((await evening.instance.run()).count, 2);
  assert.equal(evening.alerts[0].text, "Rhymat: 2 commandes livrees aujourd'hui.");
  assert.equal(evening.alerts[0].key, 'delivered:2026-11-25');

  const later = digest({ parcels, at: '2026-11-25T21:05:00Z' });
  await later.instance.run();
  assert.equal(later.alerts.length, 0);

  const early = digest({ parcels, at: '2026-11-25T18:00:00Z' });
  await early.instance.run();
  assert.equal(early.alerts.length, 0);

  const none = digest({ parcels: [parcels[2]], at: '2026-11-25T20:05:00Z' });
  assert.equal((await none.instance.run()).count, 0);
  assert.equal(none.alerts.length, 0);
});
