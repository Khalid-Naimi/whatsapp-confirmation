import test from 'node:test';
import assert from 'node:assert/strict';
import { log, redact, setLogSink } from '../src/log.js';
import { createApp } from '../src/app.js';

test('redact hides phones (plain, spaced, url-encoded), emails, tokens, consumer keys and secret query values', () => {
  const text = redact('call +212 708-357533 or 212612345678 or %2B212612345678, mail khalid@example.com, Bearer abc.def, Basic Zm9vOmJhcg==, ck_1234567890abcdef cs_1234567890abcdef, https://x/y?consumer_key=K1&consumer_secret=S1&token=T1&page=2 {"password":"hunter2","apiToken":"tok"}');
  for (const leak of ['708-357533', '612345678', 'khalid@', 'abc.def', 'Zm9vOmJhcg', 'ck_1234567890abcdef', 'cs_1234567890abcdef', 'K1', 'S1', 'T1', 'hunter2', '"tok"']) {
    assert.ok(!text.includes(leak), leak);
  }
  assert.ok(text.includes('page=2'));
});

test('redact leaves dates, times, order ids and short numbers alone', () => {
  assert.equal(redact('order 12345 at 2026-11-15T10:00:00.000Z took 300 ms'), 'order 12345 at 2026-11-15T10:00:00.000Z took 300 ms');
});

test('redact hides any secret value handed in', () => {
  assert.equal(redact('the key is s3cr3t-value', { secrets: ['s3cr3t-value', ''] }), 'the key is [redacted]');
});

test('log writes one redacted JSON line at the right level', () => {
  const lines = [];
  const sink = { log: (m) => lines.push(['log', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
  const now = () => new Date('2026-11-15T10:00:00Z');
  log('warn', 'send_failed', { phone: '+212612345678', email: 'a.b@example.com', orderId: '77' }, { logger: sink, now });
  log('info', 'ok', {}, { logger: sink, now });
  log('error', 'boom', { circular: (() => { const a = {}; a.a = a; return a; })() }, { logger: sink, now });
  assert.deepEqual(lines.map(([level]) => level), ['warn', 'log', 'error']);
  const first = JSON.parse(lines[0][1]);
  assert.equal(first.event, 'send_failed');
  assert.equal(first.at, '2026-11-15T10:00:00.000Z');
  assert.equal(first.orderId, '77');
  assert.doesNotMatch(lines[0][1], /612345678|a\.b@/u);
  assert.equal(JSON.parse(lines[2][1]).note, 'fields could not be serialized');
});

test('the default sink can be swapped', () => {
  const lines = [];
  const previous = setLogSink({ log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) });
  try {
    log('info', 'hello', { to: '+212612345678' });
  } finally {
    setLogSink(previous);
  }
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /612345678/u);
});

test('an unexpected route error is logged as one redacted JSON line', async () => {
  const lines = [];
  const logger = { log() {}, warn() {}, error: (m) => lines.push(m) };
  const handler = createApp({
    config: { tasks: { secret: 's' } },
    confirmationService: { async getOrdersSummaryForApi() { throw new Error('Woo said no for +212612345678'); } },
    store: {},
    logger
  });
  const status = await new Promise((resolve) => {
    handler({ method: 'GET', url: '/api/orders/summary', headers: { 'x-task-secret': 's' } }, { writeHead(code) { this.code = code; }, end() { resolve(this.code); } });
  });
  assert.equal(status, 500);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'http_handler_failed');
  assert.doesNotMatch(lines[0], /612345678/u);
});
