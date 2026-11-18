import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/utils/semaphore.js';
import { WooCommerceClient } from '../src/services/woocommerce-client.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('at most the limit of jobs run at once and the others go in order', async () => {
  const gate = new Semaphore({ limit: 2, maxWaitMs: 5000 });
  let running = 0;
  let peak = 0;
  const started = [];
  const jobs = [1, 2, 3, 4, 5].map((id) => gate.run(async () => {
    started.push(id);
    running += 1;
    peak = Math.max(peak, running);
    await wait(10);
    running -= 1;
    return id;
  }));
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.deepEqual(gate.stats(), { running: 0, waiting: 0 });
});

test('a failing job frees its slot', async () => {
  const gate = new Semaphore({ limit: 1 });
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('a job that waits too long is not started and fails with a TimeoutError', async () => {
  const gate = new Semaphore({ limit: 1, maxWaitMs: 20 });
  const slow = gate.run(() => wait(80));
  let started = false;
  await assert.rejects(gate.run(async () => { started = true; }, 'test call'), (error) => error.name === 'TimeoutError' && /test call/.test(error.message));
  assert.equal(started, false);
  await slow;
  assert.deepEqual(gate.stats(), { running: 0, waiting: 0 });
});

test('the WooCommerce client never has more calls open than its limit', async () => {
  let open = 0;
  let peak = 0;
  const fetchImpl = async () => {
    open += 1;
    peak = Math.max(peak, open);
    await wait(10);
    open -= 1;
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"id":1}', json: async () => ({ id: 1 }) };
  };
  const client = new WooCommerceClient({
    baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', fetchImpl, maxConcurrent: 3,
    logger: { log() {}, warn() {}, error() {} }
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => client.getOrder(index + 1)));
  assert.equal(peak, 3);
});
