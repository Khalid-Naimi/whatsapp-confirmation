import test from 'node:test';
import assert from 'node:assert/strict';
import { WooCommerceClient } from '../src/services/woocommerce-client.js';

test('WooCommerceClient retries GET with query auth after 415 response', async () => {
  const calls = [];
  const logs = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    logger: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      if (calls.length === 1) {
        return {
          ok: false,
          status: 415,
          async json() {
            return null;
          }
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return [{ id: 1 }];
        }
      };
    }
  });

  const orders = await client.listOrders({ status: 'processing', perPage: 1, page: 1 });

  assert.deepEqual(orders, [{ id: 1 }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /status=processing/);
  assert.equal(calls[0].options.headers.Authorization.startsWith('Basic '), true);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.match(calls[1].url, /consumer_key=ck_test/);
  assert.match(calls[1].url, /consumer_secret=cs_test/);
  assert.ok(logs.some((message) => message.includes('status=415')));
  assert.ok(logs.every((message) => !message.includes('[woo] request method=GET')));
  assert.ok(logs.every((message) => !message.includes('count=1')));
});

test('WooCommerceClient does not retry non-retriable failures', async () => {
  let attempts = 0;
  const logs = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    logger: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 500,
        async json() {
          return { message: 'server_error' };
        }
      };
    }
  });

  await assert.rejects(
    client.listOrders({ status: 'processing', perPage: 1, page: 1 }),
    /WooCommerce request failed with 500/
  );
  assert.equal(attempts, 1);
  assert.ok(logs.some((message) => message.includes('bodyFormat=json body={"message":"server_error"}')));
});

test('WooCommerceClient summarizes successful single-order responses without dumping full payloads', async () => {
  const logs = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    logger: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: 123,
          status: 'completed',
          billing: { first_name: 'Khalid' }
        };
      }
    })
  });

  const order = await client.getOrder(123);

  assert.equal(order.id, 123);
  assert.equal(logs.length, 0);
});

test('WooCommerceClient truncates large failure bodies in logs', async () => {
  const logs = [];
  const longMessage = 'x'.repeat(700);
  const client = new WooCommerceClient({
    baseUrl: 'https://example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    logger: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async json() {
        return {
          message: longMessage
        };
      }
    })
  });

  await assert.rejects(client.getOrder(321), /WooCommerce request failed with 400/);

  const failureLog = logs.find((message) => message.includes('[woo] failure'));
  assert.ok(failureLog);
  assert.ok(failureLog.includes('...'));
  assert.ok(!failureLog.includes(longMessage));
});

test('WooCommerceClient reports non-JSON failure bodies with a text snippet', async () => {
  const logs = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    logger: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return '<html><body>server exploded</body></html>';
      }
    })
  });

  await assert.rejects(
    client.getOrder(456),
    /WooCommerce request failed with 500: non-JSON body/
  );

  const failureLog = logs.find((message) => message.includes('[woo] failure'));
  assert.ok(failureLog?.includes('bodyFormat=text'));
  assert.ok(failureLog?.includes('server exploded'));
});

test('WooCommerceClient reports empty failure bodies explicitly', async () => {
  const logs = [];
  const client = new WooCommerceClient({
    baseUrl: 'https://example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    logger: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return '';
      }
    })
  });

  await assert.rejects(
    client.getOrder(654),
    /WooCommerce request failed with 500: empty body/
  );

  const failureLog = logs.find((message) => message.includes('[woo] failure'));
  assert.ok(failureLog?.includes('bodyFormat=empty'));
});
