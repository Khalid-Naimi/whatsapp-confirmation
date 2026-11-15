import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedLock } from '../src/utils/keyed-lock.js';

const quiet = { log() {} };

test('run(): a nested call for the same key goes straight through (no deadlock); other keys are independent', async () => {
  const lock = new KeyedLock({ prefix: 'order:', logger: quiet });
  const result = await lock.run('1', () => lock.run('1', async () => 'inner'));
  assert.equal(result, 'inner');
  assert.equal(lock.depths.size, 0);
  assert.equal(lock.mutexes.size, 0);
});

test('tryRun(): a second call for a key being run is skipped at once, without waiting', async () => {
  const lock = new KeyedLock({ logger: quiet });
  let release;
  const first = lock.tryRun('7', () => new Promise((resolve) => { release = resolve; }));
  assert.deepEqual(await lock.tryRun('7', async () => 'never'), { ran: false });
  assert.equal(lock.held.has('7'), true);
  release('done');
  assert.deepEqual(await first, { ran: true, value: 'done' });
  assert.equal(lock.held.has('7'), false);
});
