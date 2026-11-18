import test from 'node:test';
import assert from 'node:assert/strict';
import { WasenderClient, BACKLOG_ALERT_AFTER_MS, BACKLOG_ALERT_EVERY_MS } from '../src/services/wasender-client.js';
import { buildReadiness } from '../src/services/health-tracker.js';

function makeClient(clock) {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"success":true,"data":{"msgId":1}}', json: async () => ({ success: true, data: { msgId: 1 } }) });
  return new WasenderClient({
    baseUrl: 'https://wasender.example', apiToken: 'token', fetchImpl, minIntervalMs: 0, nowImpl: () => clock.now, sleepImpl: async () => {},
    logger: { log() {}, warn() {}, error() {} }
  });
}

test('queueStats counts the waiting sends and the age of the oldest', async () => {
  const clock = { now: 1_000_000 };
  const client = makeClient(clock);
  assert.deepEqual(client.queueStats(), { waiting: 0, oldestWaitMs: 0 });
  client.pumping = true; // hold the queue so the sends stay waiting
  client.sendMessage({ to: '+212600000001', message: 'a' });
  clock.now += 90_000;
  client.sendMessage({ to: '+212600000002', message: 'b' });
  assert.deepEqual(client.queueStats(), { waiting: 2, oldestWaitMs: 90_000 });
});

test('a send that waited more than 10 minutes tells the team once, then at most every 30 minutes', async () => {
  const clock = { now: 5_000_000 };
  const client = makeClient(clock);
  const alerts = [];
  client.onBacklog = (info) => alerts.push(info);
  client.pumping = true;
  const first = client.sendMessage({ to: '+212600000001', message: 'a' });
  const second = client.sendMessage({ to: '+212600000002', message: 'b' });
  clock.now += BACKLOG_ALERT_AFTER_MS + 1000;
  client.pumping = false;
  client.pump();
  await Promise.all([first, second]);
  assert.equal(alerts.length, 1, 'one alert for the whole backlog');
  assert.ok(alerts[0].waitMs >= BACKLOG_ALERT_AFTER_MS);

  client.pumping = true;
  const third = client.sendMessage({ to: '+212600000003', message: 'c' });
  clock.now += BACKLOG_ALERT_AFTER_MS + 1000; // still inside the 30 minutes since the last alert
  client.pumping = false;
  client.pump();
  await third;
  assert.equal(alerts.length, 1);

  client.pumping = true;
  const fourth = client.sendMessage({ to: '+212600000004', message: 'd' });
  clock.now += BACKLOG_ALERT_EVERY_MS;
  client.pumping = false;
  client.pump();
  await fourth;
  assert.equal(alerts.length, 2);
});

test('the readiness page shows the queue as numbers and stays ready when the queue is long', () => {
  const readiness = buildReadiness({ config: { errors: [] }, queueStats: () => ({ waiting: 40, oldestWaitMs: 1_500_000 }) });
  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.queue, { waiting: 40, oldestWaitSeconds: 1500 });
  assert.equal(buildReadiness({ config: { errors: [] } }).queue, undefined);
});
