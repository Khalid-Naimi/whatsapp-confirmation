import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, backoffDelay, request } from '../src/http/request.js';
import { WasenderClient, WasenderSendError } from '../src/services/wasender-client.js';
import { WooCommerceClient } from '../src/services/woocommerce-client.js';
import { WORDPRESS_TIMEOUT_MS, WordPressClient } from '../src/services/wordpress-client.js';
import { HighDeliveryClient } from '../src/services/highdelivery-client.js';

const quiet = { log() {}, warn() {}, error() {} };

function scripted(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) {
      throw next;
    }
    const { status = 200, body = {} } = next || {};
    return { ok: status < 400, status, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } };
  };
  return { calls, fetchImpl };
}

const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const noSleep = async () => {};

test('a GET is retried on no answer, 429 and 5xx, then succeeds', async () => {
  const { calls, fetchImpl } = scripted([timeoutError(), { status: 503 }, { status: 429 }, { body: { fine: true } }]);
  const sleeps = [];
  const reply = await request({ url: 'https://x.example/a', fetchImpl, sleep: async (ms) => sleeps.push(ms), attempts: 4, random: () => 0.5 });
  assert.deepEqual(reply.data, { fine: true });
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test('a 4xx is never retried, and three failures give up with the last error', async () => {
  const refused = scripted([{ status: 404, body: { code: 'nope' } }, { body: {} }]);
  await assert.rejects(request({ url: 'https://x.example/a', fetchImpl: refused.fetchImpl, sleep: noSleep }), (error) => error instanceof HttpError && error.kind === 'http' && error.status === 404 && error.data.code === 'nope');
  assert.equal(refused.calls.length, 1);
  const down = scripted([{ status: 500 }, { status: 502 }, { status: 503 }, { body: {} }]);
  await assert.rejects(request({ url: 'https://x.example/a', fetchImpl: down.fetchImpl, sleep: noSleep }), (error) => error.status === 503);
  assert.equal(down.calls.length, 3);
});

test('writes are retried only when idempotent; a POST create is never retried', async () => {
  const put = scripted([{ status: 502 }, { body: { id: 1 } }]);
  assert.deepEqual((await request({ method: 'PUT', url: 'https://x.example/p', body: { stock: 2 }, idempotent: true, fetchImpl: put.fetchImpl, sleep: noSleep })).data, { id: 1 });
  assert.equal(put.calls.length, 2);
  assert.equal(put.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(put.calls[0].init.body, '{"stock":2}');
  const post = scripted([{ status: 502 }, { body: {} }]);
  await assert.rejects(request({ method: 'POST', url: 'https://x.example/notes', body: { note: 'x' }, fetchImpl: post.fetchImpl, sleep: noSleep }));
  assert.equal(post.calls.length, 1);
  const none = scripted([{ status: 502 }, { body: {} }]);
  await assert.rejects(request({ url: 'https://x.example/a', retry: 'none', fetchImpl: none.fetchImpl, sleep: noSleep }));
  assert.equal(none.calls.length, 1);
});

test('one error type: timeout / network / http, with ambiguity for writes without a clear answer', async () => {
  const kinds = async (answer, method = 'GET') => {
    const { fetchImpl } = scripted([answer]);
    try {
      await request({ method, url: 'https://x.example/a', retry: 'none', fetchImpl });
    } catch (error) {
      return [error.kind, error.status, error.ambiguous];
    }
    return null;
  };
  assert.deepEqual(await kinds(timeoutError()), ['timeout', 0, false]);
  assert.deepEqual(await kinds(new TypeError('fetch failed')), ['network', 0, false]);
  assert.deepEqual(await kinds(timeoutError(), 'POST'), ['timeout', 0, true]);
  assert.deepEqual(await kinds(new TypeError('fetch failed'), 'POST'), ['network', 0, true]);
  assert.deepEqual(await kinds({ status: 500 }, 'POST'), ['http', 500, true]);
  assert.deepEqual(await kinds({ status: 422 }, 'POST'), ['http', 422, false]);
  assert.deepEqual(await kinds({ status: 500 }), ['http', 500, false]);
});

test('messages are redacted: phones, tokens, consumer keys and secret query values; the reply body is never in the message', async () => {
  const { fetchImpl } = scripted([new TypeError('connect ECONNREFUSED for +212612345678 Bearer abc.def ?consumer_key=ck_1234567890abcdef&consumer_secret=cs_1234567890abcdef&token=zzz')]);
  const error = await request({ url: 'https://x.example/a', retry: 'none', fetchImpl, secrets: ['my-very-secret'] }).catch((e) => e);
  assert.doesNotMatch(error.message, /612345678|abc\.def|ck_1234567890abcdef|cs_1234567890abcdef|zzz/u);
  const echo = scripted([{ status: 400, body: { message: 'bad number +212612345678 my-very-secret' } }]);
  const http = await request({ url: 'https://x.example/a', fetchImpl: echo.fetchImpl, secrets: ['my-very-secret'] }).catch((e) => e);
  assert.equal(http.message, 'request failed with 400');
  assert.match(http.data.message, /\+212612345678/u); // kept on the error for code that needs it, never in the text
});

test('backoff doubles, is capped, jitters by +-25 % and honours Retry-After', () => {
  assert.equal(backoffDelay(1, { random: () => 0.5 }), 1000);
  assert.equal(backoffDelay(3, { random: () => 0.5 }), 4000);
  assert.equal(backoffDelay(10, { random: () => 0.5, maxDelayMs: 5000 }), 5000);
  assert.equal(backoffDelay(1, { random: () => 0 }), 750);
  assert.equal(backoffDelay(1, { random: () => 0.999999 }), 1250);
  assert.equal(backoffDelay(1, { retryAfterMs: 3000 }), 3000);
});

test('Woo errors carry the status and the error code only, never the reply body; the query keys never reach a log', async () => {
  const logs = [];
  const { fetchImpl } = scripted([{ status: 401 }, { status: 400, body: { code: 'rest_invalid_param', message: 'customer +212612345678 khalid@example.com' } }]);
  const client = new WooCommerceClient({ baseUrl: 'https://shop.example', consumerKey: 'ck_1234567890abcdef', consumerSecret: 'cs_1234567890abcdef', fetchImpl, sleepImpl: noSleep, logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  const error = await client.getOrder(5).catch((e) => e);
  assert.equal(error.message, 'WooCommerce request failed with 400: rest_invalid_param');
  assert.equal(error.status, 400);
  const text = logs.join('\n');
  assert.doesNotMatch(text, /612345678|khalid@|ck_1234567890abcdef|cs_1234567890abcdef/u);
});

test('Woo: a network error on an order note is not retried (it could add the note twice)', async () => {
  const { calls, fetchImpl } = scripted([new TypeError('fetch failed'), { body: {} }]);
  const client = new WooCommerceClient({ baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', fetchImpl, sleepImpl: noSleep, logger: quiet });
  await assert.rejects(client.addOrderNote(5, 'n'), (error) => error.kind === 'network' && error.ambiguous === true);
  assert.equal(calls.length, 1);
});

test('Wasender: no answer is ambiguous, a refusal says the status without the body or the phone', async () => {
  const make = (answers) => new WasenderClient({ baseUrl: 'https://wa.example/api', apiToken: 'tok-secret', minIntervalMs: 0, sleepImpl: noSleep, logger: quiet, fetchImpl: scripted(answers).fetchImpl });
  await assert.rejects(make([timeoutError()]).sendMessage({ to: '+212612345678', message: 'x' }), (error) => error instanceof WasenderSendError && error.ambiguous === true && error.status === 0);
  const refused = await make([{ status: 422, body: { message: 'Recipient +212612345678 not registered on WhatsApp' } }]).sendMessage({ to: '+212612345678', message: 'x' }).catch((e) => e);
  assert.equal(refused.message, 'Wasender send-message failed with 422');
  assert.equal(refused.ambiguous, false);
  assert.match(refused.data.message, /not registered on WhatsApp/u);
  const server = await make([{ status: 500, body: { message: 'gateway' } }]).sendMessage({ to: '+212612345678', message: 'x' }).catch((e) => e);
  assert.deepEqual([server.status, server.ambiguous], [500, false]);
});

test('WordPress: 15 s timeout, reads retried, the inbound copy never; it never throws', async () => {
  assert.equal(WORDPRESS_TIMEOUT_MS, 15000);
  const read = scripted([{ status: 503 }, { body: [{ phone: '+212600000001' }] }]);
  const client = new WordPressClient({ baseUrl: 'https://wp.example', fetchImpl: read.fetchImpl, sleepImpl: noSleep, logger: quiet });
  assert.deepEqual(await client.getOptedOutContacts(), { ok: true, status: 200, data: [{ phone: '+212600000001' }] });
  assert.equal(read.calls.length, 2);
  const inbound = scripted([{ status: 503, body: { code: 'down' } }]);
  const writer = new WordPressClient({ baseUrl: 'https://wp.example', fetchImpl: inbound.fetchImpl, sleepImpl: noSleep, logger: quiet });
  assert.deepEqual(await writer.postInbound({ a: 1 }), { ok: false, status: 503, data: { code: 'down' } });
  assert.equal(inbound.calls.length, 1);
  const broken = new WordPressClient({ baseUrl: 'https://wp.example', fetchImpl: async () => { throw new TypeError('fetch failed'); }, sleepImpl: noSleep, logger: quiet });
  const result = await broken.optOutContact('+212600000001');
  assert.equal(result.ok, false);
  assert.match(result.error, /no answer/u);
});

test('WordPress: the opt-out path with the phone is redacted in the log', async () => {
  const lines = [];
  const client = new WordPressClient({ baseUrl: 'https://wp.example', fetchImpl: scripted([{ status: 400, body: {} }]).fetchImpl, sleepImpl: noSleep, logger: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } });
  await client.optOutContact('+212612345678');
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /612345678/u);
  assert.equal(JSON.parse(lines[0]).event, 'wordpress_call_failed');
});

test('HighDelivery: reads retried on 5xx; a parcel creation is never repeated and stays ambiguous on no answer', async () => {
  const urls = [];
  const answers = [{ status: 200, body: { success: true, data: { token: 't' } } }, { status: 502, body: {} }, { status: 200, body: { success: true, data: { cities: [{ id: 1, name_fr: 'Casablanca' }] } } }, new TypeError('socket hang up')];
  const client = new HighDeliveryClient({
    phone: 'p', password: 'pw', logger: quiet, sleepImpl: noSleep,
    fetchImpl: async (url, init) => {
      urls.push(`${init.method} ${url}`);
      const next = answers.shift();
      if (next instanceof Error) {
        throw next;
      }
      return { status: next.status, json: async () => next.body };
    }
  });
  const error = await client.createPackage({ recipientName: 'A', recipientPhone: '0612345678', address: 'Rue', city: 'Casablanca', productName: 'Tee', codAmount: 1 }).catch((e) => e);
  assert.equal(error.ambiguous, true);
  assert.match(error.message, /Could not reach HighDelivery/u);
  assert.equal(urls.filter((u) => u.includes('/cities')).length, 2);
  assert.equal(urls.filter((u) => u.startsWith('POST') && u.endsWith('/client/packages')).length, 1);
});
