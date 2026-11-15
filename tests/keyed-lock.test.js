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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('run(): independent concurrent callers for one key never overlap (max concurrency 1), in arrival order', async () => {
  const lock = new KeyedLock({ logger: quiet });
  let running = 0;
  let max = 0;
  const order = [];
  const work = (name) => async () => {
    running += 1;
    max = Math.max(max, running);
    order.push(name);
    await pause(5);
    running -= 1;
  };
  await Promise.all(['a', 'b', 'c'].map((name) => lock.run('1', work(name))));
  assert.equal(max, 1);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(lock.depths.size, 0);
  assert.equal(lock.mutexes.size, 0);
});

test('run(): true nested re-entry (same call chain) still runs at once, even after awaits', async () => {
  const lock = new KeyedLock({ logger: quiet });
  const result = await lock.run('1', async () => {
    await pause(1);
    return lock.run('1', async () => {
      await pause(1);
      return lock.run('1', async () => 'deep');
    });
  });
  assert.equal(result, 'deep');
});

test('run(): a timer scheduled inside the lock that fires after the release waits for the next holder', async () => {
  const lock = new KeyedLock({ logger: quiet });
  const events = [];
  let timerDone;
  const timerFinished = new Promise((resolve) => { timerDone = resolve; });
  await lock.run('1', async () => {
    setTimeout(() => {
      lock.run('1', async () => { events.push('timer'); }).then(timerDone);
    }, 5);
  });
  // The next holder takes the lock before the timer fires and keeps it a while.
  const next = lock.run('1', async () => {
    events.push('next:start');
    await pause(20);
    events.push('next:end');
  });
  await Promise.all([next, timerFinished]);
  assert.deepEqual(events, ['next:start', 'next:end', 'timer']);
  assert.equal(lock.depths.size, 0);
  assert.equal(lock.mutexes.size, 0);
});

test('run(): a failing holder releases the lock (no leak) and the next caller runs', async () => {
  const lock = new KeyedLock({ logger: quiet });
  await assert.rejects(lock.run('1', async () => { throw new Error('boom'); }), /boom/u);
  assert.equal(await lock.run('1', async () => 'after'), 'after');
  assert.equal(lock.depths.size, 0);
  assert.equal(lock.mutexes.size, 0);
});

test('outsideLocks(): a task started inside the lock queues behind the holder instead of re-entering', async () => {
  const { outsideLocks } = await import('../src/utils/keyed-lock.js');
  const lock = new KeyedLock({ logger: quiet });
  const events = [];
  let inherited;
  let detached;
  await lock.run('1', async () => {
    inherited = lock.run('1', async () => { events.push('inherited'); });
    detached = outsideLocks(() => lock.run('1', async () => { events.push('detached'); }));
    await pause(10);
    events.push('holder:end');
  });
  await Promise.all([inherited, detached]);
  // A plain call from inside still re-enters (same chain); the detached one waits for the holder.
  assert.deepEqual(events, ['inherited', 'holder:end', 'detached']);
});

test('run(): a long wait is logged after 60 s and gives up after 180 s with LockTimeoutError; the line keeps moving', async (t) => {
  const { LockTimeoutError } = await import('../src/utils/keyed-lock.js');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const warnings = [];
  const lock = new KeyedLock({ prefix: 'order:', logger: { log() {}, warn: (m) => warnings.push(m) } });
  let release;
  const holder = lock.run('1', () => new Promise((resolve) => { release = resolve; }));
  const flush = async () => { for (let i = 0; i < 10; i += 1) { await Promise.resolve(); } };
  await flush();
  let outcome = null;
  const waiter = lock.run('1', async () => 'ran').then((v) => { outcome = v; }, (e) => { outcome = e; });
  await flush();
  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /waiting more than 60 s for lockKey=order:1/u);
  assert.equal(outcome, null);
  t.mock.timers.tick(120 * 1000);
  await waiter;
  assert.ok(outcome instanceof LockTimeoutError);
  // A caller behind the one that gave up still gets the lock once the holder finishes.
  const third = lock.run('1', async () => 'third');
  release('done');
  await holder;
  assert.equal(await third, 'third');
  assert.equal(lock.depths.size, 0);
  assert.equal(lock.mutexes.size, 0);
});
