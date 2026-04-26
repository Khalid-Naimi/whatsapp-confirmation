import test from 'node:test';
import assert from 'node:assert/strict';
import { WasenderClient } from '../src/services/wasender-client.js';
import { WasenderSendError } from '../src/services/wasender-client.js';

test('WasenderClient spaces consecutive sends to respect account protection', async () => {
  const callTimes = [];
  let currentTime = 0;

  const client = new WasenderClient({
    baseUrl: 'https://example.com/api',
    apiToken: 'token',
    minIntervalMs: 5000,
    nowImpl: () => currentTime,
    sleepImpl: async (ms) => {
      currentTime += ms;
    },
    fetchImpl: async () => {
      callTimes.push(currentTime);
      return {
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }
  });

  await Promise.all([
    client.sendMessage({ to: '+212612345678', message: 'first' }),
    client.sendMessage({ to: '+212612345679', message: 'second' })
  ]);

  assert.deepEqual(callTimes, [0, 5000]);
});

test('WasenderClient retries after 429 using retry_after delay', async () => {
  let currentTime = 0;
  let attempts = 0;
  const sleepCalls = [];

  const client = new WasenderClient({
    baseUrl: 'https://example.com/api',
    apiToken: 'token',
    nowImpl: () => currentTime,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
      currentTime += ms;
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          async json() {
            return { retry_after: 2 };
          }
        };
      }

      return {
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }
  });

  const result = await client.sendMessage({ to: '+212612345678', message: 'hello' });

  assert.equal(attempts, 2);
  assert.deepEqual(sleepCalls, [2000]);
  assert.deepEqual(result, { ok: true });
});

test('WasenderClient throws after exhausting 429 retries', async () => {
  let attempts = 0;

  const client = new WasenderClient({
    baseUrl: 'https://example.com/api',
    apiToken: 'token',
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 429,
        async json() {
          return { retry_after: 1 };
        }
      };
    }
  });

  await assert.rejects(
    () => client.sendMessage({ to: '+212612345678', message: 'hello' }),
    WasenderSendError
  );
  assert.equal(attempts, 3);
});
