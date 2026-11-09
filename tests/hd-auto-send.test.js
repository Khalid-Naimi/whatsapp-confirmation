import test from 'node:test';
import assert from 'node:assert/strict';
import { HighDeliveryClient, HighDeliveryError, extractTrackingNumber } from '../src/services/highdelivery-client.js';
import { HD_META, HdAutoSendService, buildParcelFromWooOrder, normalizeMoroccanPhone } from '../src/services/hd-auto-send-service.js';

const quietLogger = { log() {}, warn() {}, error() {} };

function reply(status, payload) {
  return { status, async json() { if (payload === undefined) { throw new Error('no json'); } return payload; } };
}
const ok = (data) => reply(200, { success: true, message: 'ok', data });
const login = (token = 'tok-1') => ok({ token, user: { id: 2 } });
const cities = (...names) => ok({ cities: names.map((name, index) => ({ id: 400 + index, name_fr: name })) });
const created = (tracking = 'HD-123') => ok({ package: { id: 7, tracking_number: tracking } });
const refused = (status, message, errors) => reply(status, { success: false, message, errors });

function scriptedFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = replies.shift();
    if (next instanceof Error) { throw next; }
    return next;
  };
  return { fetchImpl, calls };
}

function makeClient(replies) {
  const { fetchImpl, calls } = scriptedFetch(replies);
  return { client: new HighDeliveryClient({ phone: '0611111111', password: 'pw', fetchImpl, logger: quietLogger }), calls };
}

const parcelArgs = { recipientName: 'Jane Doe', recipientPhone: '0612345678', address: 'Rue 1', city: 'casablanca', productName: 'Hoodie M x2', codAmount: 399 };

test('client logs in with phone and password, reuses the token and reads cities', async () => {
  const { client, calls } = makeClient([login('abc'), cities('Agadir', 'Casablanca')]);
  assert.equal((await client.resolveCity('CASABLANCA')).name_fr, 'Casablanca');
  assert.equal(calls[0].url, 'https://api.highdelivery.pro/api/auth/login');
  assert.deepEqual(calls[0].body, { phone: '0611111111', password: 'pw' });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Authorization, 'Bearer abc');
  assert.equal(await client.resolveCity('Atlantis'), null);
  assert.equal(calls.length, 2); // cities are cached
});

test('city match ignores case and accents', async () => {
  const { client } = makeClient([login(), cities('Aïn Aïcha', 'Fès')]);
  assert.equal((await client.resolveCity('AIN AICHA')).name_fr, 'Aïn Aïcha');
  assert.equal((await client.resolveCity('fes')).name_fr, 'Fès');
  assert.equal(await client.resolveCity(''), null);
});

test('createPackage sends the platform city name and returns the tracking number', async () => {
  const { client, calls } = makeClient([login(), cities('Agadir', 'Casablanca'), created('HD-777')]);
  const result = await client.createPackage({ ...parcelArgs, comment: 'Woo #5' });
  assert.equal(result.trackingNumber, 'HD-777');
  const post = calls.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.url, 'https://api.highdelivery.pro/api/client/packages');
  assert.deepEqual(post.body, {
    recipient_name: 'Jane Doe', recipient_phone: '0612345678', address: 'Rue 1', city: 'Casablanca',
    product_name: 'Hoodie M x2', cod_amount: 399, allow_opening: true, is_express: false, comment: 'Woo #5'
  });
});

test('a city HighDelivery does not serve is refused before anything is sent', async () => {
  const { client, calls } = makeClient([login(), cities('Agadir')]);
  await assert.rejects(client.createPackage({ ...parcelArgs, city: 'Atlantis' }), /not served/);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/client/packages')).length, 0);
});

test('a refusal keeps the status and the server reply', async () => {
  const { client } = makeClient([login(), cities('Casablanca'), refused(422, 'Validation error', [{ field: 'recipient_phone', msg: 'invalid' }])]);
  await assert.rejects(client.createPackage(parcelArgs), (error) => {
    assert.ok(error instanceof HighDeliveryError);
    assert.equal(error.status, 422);
    assert.equal(error.ambiguous, false);
    assert.match(error.detail(), /Validation error \| HTTP 422 \| server reply: .*recipient_phone/u);
    return true;
  });
});

test('when the server asks for city_id the parcel is retried once with the id', async () => {
  const { client, calls } = makeClient([login(), cities('Casablanca'), refused(400, 'city_id is required'), created('HD-9')]);
  await client.createPackage(parcelArgs);
  const posts = calls.filter((call) => call.url.endsWith('/client/packages'));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.city_id, undefined);
  assert.equal(posts[1].body.city_id, 400);
});

test('any other refusal is not retried', async () => {
  const { client, calls } = makeClient([login(), cities('Casablanca'), refused(500, 'boom')]);
  await assert.rejects(client.createPackage(parcelArgs), /boom/);
  assert.equal(calls.filter((call) => call.url.endsWith('/client/packages')).length, 1);
});

test('an expired token is refreshed once while creating', async () => {
  const { client, calls } = makeClient([login('old'), cities('Casablanca'), reply(401, {}), login('new'), created()]);
  await client.createPackage(parcelArgs);
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer new');
});

test('a dropped connection on the create call is flagged ambiguous (the parcel may exist)', async () => {
  const { client } = makeClient([login(), cities('Casablanca'), new Error('socket hang up')]);
  await assert.rejects(client.createPackage(parcelArgs), (error) => error.ambiguous === true && /Could not reach/u.test(error.message));
});

test('a wrong password reports the server message and is not ambiguous', async () => {
  const { client } = makeClient([refused(401, 'Identifiants invalides')]);
  await assert.rejects(client.login(), (error) => /Identifiants invalides/u.test(error.message) && error.ambiguous === false);
});

test('tracking number is found wherever the reply nests it', () => {
  assert.equal(extractTrackingNumber({ package: { tracking_number: 'A1' } }), 'A1');
  assert.equal(extractTrackingNumber({ trackingNumber: 'B2' }), 'B2');
  assert.equal(extractTrackingNumber([{ x: 1 }, { y: { tracking_number: 'C3' } }]), 'C3');
  assert.equal(extractTrackingNumber({}), '');
});

test('Moroccan phone numbers are normalised and anything else is refused', () => {
  assert.equal(normalizeMoroccanPhone('212612345678'), '0612345678');
  assert.equal(normalizeMoroccanPhone('+212 6 12 34 56 78'), '0612345678');
  assert.equal(normalizeMoroccanPhone('00212712345678'), '0712345678');
  assert.equal(normalizeMoroccanPhone('0612345678'), '0612345678');
  assert.equal(normalizeMoroccanPhone('612345678'), '0612345678');
  assert.equal(normalizeMoroccanPhone('+491729031097'), '');
  assert.equal(normalizeMoroccanPhone('123'), '');
  assert.equal(normalizeMoroccanPhone(''), '');
});

function wooOrder(overrides = {}) {
  return {
    id: 501,
    status: 'on-hold',
    total: '399.00',
    currency: 'MAD',
    shipping: { first_name: 'Jane', last_name: 'Doe', city: 'Casablanca', address_1: 'Rue 1', address_2: 'Etage 2', phone: '212612345678' },
    billing: { first_name: 'J', last_name: 'D', phone: '212699999999' },
    line_items: [{ name: 'Hoodie M', quantity: 2 }, { name: 'Cap', quantity: 1 }],
    meta_data: [],
    ...overrides
  };
}

test('a Woo order becomes a parcel; every missing piece is named', () => {
  const built = buildParcelFromWooOrder(wooOrder());
  assert.equal(built.ok, true);
  assert.deepEqual(built.parcel, {
    recipientName: 'Jane Doe', recipientPhone: '0612345678', address: 'Rue 1, Etage 2', city: 'Casablanca',
    productName: 'Hoodie M x2, Cap x1', codAmount: 399, comment: 'Woo #501'
  });
  const bad = buildParcelFromWooOrder(wooOrder({ shipping: {}, billing: { phone: '+491729031097' }, line_items: [], total: '0' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 5);
  assert.match(bad.problems.join(';'), /not a Moroccan number/u);
});

function makeService({ order = wooOrder(), createImpl, configured = true, enabled = true, failOn = {}, notifyFails = [] } = {}) {
  const events = [];
  const woo = { order: { ...order, meta_data: [...(order.meta_data || [])] } };
  const wooClient = {
    async getOrder() { events.push('get'); if (failOn.get) { throw new Error('woo down'); } return woo.order; },
    async updateOrderMeta(id, meta) {
      events.push(`meta:${meta.map((m) => `${m.key.replace('rhymat_hd_api_', '')}=${m.value}`).join(',')}`);
      if (failOn.meta) { throw new Error('meta down'); }
      for (const item of meta) {
        const index = woo.order.meta_data.findIndex((m) => m.key === item.key);
        if (index >= 0) { woo.order.meta_data[index] = item; } else { woo.order.meta_data.push(item); }
      }
      return woo.order;
    },
    async updateOrderStatus(id, status) { events.push(`status:${status}`); if (failOn.status) { throw new Error('status down'); } woo.order.status = status; return woo.order; },
    async addOrderNote(id, note) { events.push(`note:${note}`); return {}; }
  };
  const sent = [];
  const wasenderClient = {
    async sendMessage(payload) {
      if (notifyFails.includes(payload.to)) { throw new Error('wasender down'); }
      sent.push(payload); events.push(`wa:${payload.to}`); return { id: `m${sent.length}` };
    }
  };
  const messages = [];
  const upserts = [];
  const store = { appendMessage: (m) => messages.push(m), upsertOrder: (o) => upserts.push(o) };
  const hdCalls = [];
  const hdClient = {
    isConfigured: () => configured,
    async createPackage(parcel) { events.push('hd:create'); hdCalls.push(parcel); return createImpl ? createImpl(parcel) : { trackingNumber: 'HD-42', data: {} }; }
  };
  const service = new HdAutoSendService({
    hdClient, wooClient, wasenderClient, store, enabled,
    notifyPhones: ['+212708357533', '+491729031097'],
    template: 'Commande envoyee.\nNumero: {{orderId}}\nTracking: {{trackingNumber}}\nClient: {{customerName}}\nVille: {{deliveryCity}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
    logger: quietLogger
  });
  return { service, events, woo, sent, messages, upserts, hdCalls };
}

test('success: reserve, create, complete in Woo and tell both numbers', async () => {
  const { service, events, woo, sent, messages, hdCalls } = makeService();
  const result = await service.autoSend({ orderId: '501' });
  assert.deepEqual({ status: result.status, tracking: result.trackingNumber, completed: result.completed, notified: result.notified }, { status: 'sent', tracking: 'HD-42', completed: true, notified: 2 });
  assert.equal(hdCalls[0].recipientPhone, '0612345678');
  // the reservation is written before the parcel is created, and the order is completed after
  assert.ok(events.indexOf('meta:state=sending,error=') < events.indexOf('hd:create'));
  assert.ok(events.indexOf('hd:create') < events.indexOf('status:completed'));
  assert.equal(woo.order.status, 'completed');
  const meta = Object.fromEntries(woo.order.meta_data.map((m) => [m.key, m.value]));
  assert.equal(meta[HD_META.state], 'sent');
  assert.equal(meta[HD_META.tracking], 'HD-42');
  assert.ok(meta[HD_META.sentAt]);
  assert.deepEqual(sent.map((m) => m.to), ['+212708357533', '+491729031097']);
  assert.match(sent[0].message, /Numero: 501\nTracking: HD-42\nClient: Jane Doe\nVille: Casablanca\nTalab: Hoodie M x2, Cap x1\nTotal: 399.00 MAD/u);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'internal_hd_sent_notification');
  assert.ok(events.some((e) => e.startsWith('note:Sent to HighDelivery automatically. Tracking: HD-42')));
});

test('HighDelivery refuses: nothing is completed, nobody is messaged, the order stays on-hold with the reason', async () => {
  const { service, events, woo, sent } = makeService({
    createImpl: () => { throw new HighDeliveryError('Validation error', { status: 422, body: 'bad phone' }); }
  });
  const result = await service.autoSend({ orderId: '501' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Validation error \| HTTP 422 \| server reply: bad phone/u);
  assert.equal(woo.order.status, 'on-hold');
  assert.ok(!events.includes('status:completed'));
  assert.equal(sent.length, 0);
  assert.equal(Object.fromEntries(woo.order.meta_data.map((m) => [m.key, m.value]))[HD_META.state], 'failed');
  assert.ok(events.some((e) => e.startsWith('note:Auto-send to HighDelivery failed: Validation error | HTTP 422') && e.includes('desktop app')));
});

test('an answer that never came is unknown: no completion, and it can never be sent again automatically', async () => {
  const { service, woo, sent } = makeService({
    createImpl: () => { throw new HighDeliveryError('Could not reach HighDelivery: TimeoutError', { ambiguous: true }); }
  });
  assert.equal((await service.autoSend({ orderId: '501' })).status, 'unknown');
  assert.equal(woo.order.status, 'on-hold');
  assert.equal(sent.length, 0);
  assert.equal(Object.fromEntries(woo.order.meta_data.map((m) => [m.key, m.value]))[HD_META.state], 'unknown');
  const again = await service.autoSend({ orderId: '501' });
  assert.deepEqual({ status: again.status, reason: again.reason }, { status: 'skipped', reason: 'already_unknown' });
});

test('an order that was already sent (or is being sent) is never sent twice', async () => {
  for (const state of ['sent', 'sending']) {
    const { service, hdCalls } = makeService({ order: wooOrder({ meta_data: [{ key: HD_META.state, value: state }] }) });
    const result = await service.autoSend({ orderId: '501' });
    assert.equal(result.reason, `already_${state}`);
    assert.equal(hdCalls.length, 0);
  }
});

test('a failed earlier try does not block a later one', async () => {
  const { service, hdCalls } = makeService({ order: wooOrder({ meta_data: [{ key: HD_META.state, value: 'failed' }] }) });
  assert.equal((await service.autoSend({ orderId: '501' })).status, 'sent');
  assert.equal(hdCalls.length, 1);
});

test('two runs at the same time for one order create one parcel', async () => {
  const { service, hdCalls } = makeService({ createImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { trackingNumber: 'HD-1', data: {} }; } });
  const [first, second] = await Promise.all([service.autoSend({ orderId: '501' }), service.autoSend({ orderId: '501' })]);
  assert.deepEqual([first.status, second.status].sort(), ['sent', 'skipped']);
  assert.equal(hdCalls.length, 1);
});

test('an order someone already handled in Woo is left alone', async () => {
  for (const status of ['completed', 'cancelled', 'processing']) {
    const { service, hdCalls, events } = makeService({ order: wooOrder({ status }) });
    assert.equal((await service.autoSend({ orderId: '501' })).reason, `status_${status}`);
    assert.equal(hdCalls.length, 0);
    assert.ok(!events.some((e) => e.startsWith('meta:')));
  }
});

test('an order HighDelivery cannot take is left on-hold with a note and no reservation or call', async () => {
  const { service, events, hdCalls } = makeService({ order: wooOrder({ shipping: {}, billing: { phone: '+491729031097' } }) });
  const result = await service.autoSend({ orderId: '501' });
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'skipped', reason: 'invalid_order' });
  assert.equal(hdCalls.length, 0);
  assert.ok(!events.some((e) => e.startsWith('meta:')));
  assert.ok(events.some((e) => e.startsWith('note:Auto-send to HighDelivery skipped:') && /not a Moroccan number/u.test(e) && /address is missing/u.test(e)));
});

test('if the reservation cannot be saved nothing is sent', async () => {
  const { service, hdCalls } = makeService({ failOn: { meta: true } });
  assert.equal((await service.autoSend({ orderId: '501' })).reason, 'reservation_failed');
  assert.equal(hdCalls.length, 0);
});

test('Woo unreadable, switch off, or no credentials: nothing happens', async () => {
  assert.equal((await makeService({ failOn: { get: true } }).service.autoSend({ orderId: '501' })).reason, 'woo_read_failed');
  assert.equal((await makeService({ enabled: false }).service.autoSend({ orderId: '501' })).status, 'disabled');
  const noCreds = makeService({ configured: false });
  assert.equal((await noCreds.service.autoSend({ orderId: '501' })).reason, 'not_configured');
  assert.equal(noCreds.hdCalls.length, 0);
});

test('parcel sent but Woo cannot be completed: a note says so, the second number still hears about it', async () => {
  const { service, events, sent, woo } = makeService({ failOn: { status: true } });
  const result = await service.autoSend({ orderId: '501' });
  assert.deepEqual({ status: result.status, completed: result.completed, notified: result.notified }, { status: 'sent', completed: false, notified: 2 });
  assert.equal(sent.length, 2);
  assert.ok(events.some((e) => e.includes('could not be set to completed') && e.includes('do not send it again')));
  assert.equal(Object.fromEntries(woo.order.meta_data.map((m) => [m.key, m.value]))[HD_META.state], 'sent');
});

test('one WhatsApp number failing does not stop the other', async () => {
  const { service, sent } = makeService({ notifyFails: ['+212708357533'] });
  const result = await service.autoSend({ orderId: '501' });
  assert.equal(result.notified, 1);
  assert.deepEqual(sent.map((m) => m.to), ['+491729031097']);
});
