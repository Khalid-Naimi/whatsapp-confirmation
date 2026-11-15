import test from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown, keepAwakeUrl, startKeepAwake } from '../src/lifecycle.js';
import { secretMatches } from '../src/utils/signatures.js';

const quiet = { log() {}, warn() {}, error() {} };

test('keep-awake pings only a public address', () => {
  assert.equal(keepAwakeUrl({ RENDER_EXTERNAL_URL: 'https://svc.onrender.com' }), 'https://svc.onrender.com/health');
  assert.equal(keepAwakeUrl({}, 'https://example.com/base'), 'https://example.com/health');
  assert.equal(keepAwakeUrl({}, 'http://localhost:3000'), '');
  assert.equal(keepAwakeUrl({}, 'http://127.0.0.1:3000'), '');
  assert.equal(keepAwakeUrl({}, ''), '');
  assert.equal(keepAwakeUrl({}, 'not a url'), '');
});

test('keep-awake does nothing without an address and pings with a timeout when it has one', async () => {
  const calls = [];
  const stopNone = startKeepAwake({ url: '', fetchImpl: async () => calls.push('x'), logger: quiet });
  stopNone();
  const stop = startKeepAwake({
    url: 'https://svc.onrender.com/health',
    intervalMs: 5,
    fetchImpl: async (url, options) => {
      calls.push({ url, hasSignal: Boolean(options.signal) });
      return { ok: true, status: 200 };
    },
    logger: quiet
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  assert.ok(calls.length >= 1);
  assert.deepEqual(calls[0], { url: 'https://svc.onrender.com/health', hasSignal: true });
});

test('shutdown stops the server, waits for running work, then exits once', async () => {
  const order = [];
  let finishWork;
  const work = new Promise((resolve) => { finishWork = resolve; });
  const server = { close(callback) { order.push('close'); callback(); }, closeIdleConnections() { order.push('idle'); } };
  const shutdown = createShutdown({ server, waitFor: [() => work], stop: [() => order.push('timer')], graceMs: 1000, logger: quiet, exit: (code) => order.push(`exit:${code}`) });
  const done = shutdown('SIGTERM');
  shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!order.includes('exit:0'));
  finishWork();
  await done;
  assert.deepEqual(order, ['timer', 'close', 'idle', 'exit:0']);
});

test('shutdown exits after the grace time even if work hangs', async () => {
  const exits = [];
  const shutdown = createShutdown({ server: null, waitFor: [() => new Promise(() => {})], graceMs: 20, logger: quiet, exit: (code) => exits.push(code) });
  await shutdown('SIGTERM');
  assert.deepEqual(exits, [0]);
});

test('the task secret check is constant-time and fails closed', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abd', 'abc'), false);
  assert.equal(secretMatches('abcd', 'abc'), false);
  assert.equal(secretMatches(undefined, 'abc'), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches('abc', ''), false);
});
