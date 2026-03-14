import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';

function createTestContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woo-confirmation-'));
  const dataFile = path.join(tmpDir, 'db.json');
  const store = new JsonStore(dataFile);

  const wasenderCalls = [];
  const wooStatusCalls = [];
  const wooNoteCalls = [];

  const wasenderClient = {
    async sendMessage(payload) {
      wasenderCalls.push(payload);
      return { id: `msg-${wasenderCalls.length}` };
    }
  };

  const wooClient = {
    async updateOrderStatus(orderId, status) {
      wooStatusCalls.push({ orderId, status });
      return { id: orderId, status };
    },
    async addOrderNote(orderId, note) {
      wooNoteCalls.push({ orderId, note });
      return { id: `${orderId}-note` };
    }
  };

  const confirmationService = new ConfirmationService({
    store,
    wasenderClient,
    wooClient,
    messages: {
      confirmationTemplate: 'Hello {{customerName}}, reply 1 to confirm order #{{orderId}} or 2 to cancel.',
      invalidReply: 'Please reply only with 1 or 2.'
    },
    logger: {
      error() {},
      warn() {},
      log() {}
    }
  });

  const config = {
    woo: {
      webhookSecret: 'woo-secret'
    },
    wasender: {
      webhookSecret: 'wasender-secret',
      signatureHeader: 'x-wasender-signature'
    }
  };

  const app = createApp({
    config,
    confirmationService,
    logger: {
      error() {}
    }
  });

  return { app, store, wasenderCalls, wooStatusCalls, wooNoteCalls };
}

function createMockReq({ method, url, headers, body }) {
  const listeners = {};
  return {
    method,
    url,
    headers,
    on(event, callback) {
      listeners[event] = callback;
      if (event === 'data' && body) {
        callback(body);
      }
      if (event === 'end') {
        callback();
      }
    }
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

async function dispatch(app, { method, url, headers = {}, payload = {} }) {
  const body = JSON.stringify(payload);
  const req = createMockReq({ method, url, headers, body });
  const res = createMockRes();
  await app(req, res);
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body)
  };
}

function signWoo(payload) {
  return createHmac('sha256', 'woo-secret').update(JSON.stringify(payload)).digest('base64');
}

function signWasender(payload) {
  return createHmac('sha256', 'wasender-secret').update(JSON.stringify(payload)).digest('hex');
}

test('new WooCommerce order sends one confirmation message', async () => {
  const { app, wasenderCalls, store } = createTestContext();
  const payload = {
    id: 101,
    status: 'pending',
    total: '150.00',
    currency: 'MAD',
    billing: {
      first_name: 'Khalid',
      last_name: 'Naimi',
      phone: '212612345678'
    }
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-1'
    },
    payload
  });

  assert.equal(result.statusCode, 202);
  assert.equal(wasenderCalls.length, 1);
  assert.equal(store.getOrder('101').confirmationState, 'pending_confirmation');
});

test('duplicate WooCommerce webhook does not send twice', async () => {
  const { app, wasenderCalls } = createTestContext();
  const payload = {
    id: 102,
    status: 'pending',
    total: '100.00',
    currency: 'MAD',
    billing: {
      first_name: 'Sara',
      last_name: 'A',
      phone: '212600000001'
    }
  };

  const headers = {
    'x-wc-webhook-signature': signWoo(payload),
    'x-wc-webhook-delivery-id': 'delivery-2'
  };

  await dispatch(app, { method: 'POST', url: '/webhooks/woocommerce', headers, payload });
  const result = await dispatch(app, { method: 'POST', url: '/webhooks/woocommerce', headers, payload });

  assert.equal(result.statusCode, 200);
  assert.equal(wasenderCalls.length, 1);
});

test('reply 1 confirms and updates WooCommerce to processing', async () => {
  const { app, wooStatusCalls, store } = createTestContext();
  const orderPayload = {
    id: 103,
    status: 'pending',
    total: '90.00',
    currency: 'MAD',
    billing: {
      first_name: 'Lina',
      last_name: 'B',
      phone: '212600000002'
    }
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-3'
    },
    payload: orderPayload
  });

  const replyPayload = { id: 'wa-1', from: '212600000002', text: '1' };
  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasender(replyPayload)
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 202);
  assert.deepEqual(wooStatusCalls[0], { orderId: '103', status: 'processing' });
  assert.equal(store.getOrder('103').confirmationState, 'confirmed');
});

test('reply 2 cancels the order', async () => {
  const { app, wooStatusCalls, store } = createTestContext();
  const orderPayload = {
    id: 104,
    status: 'pending',
    total: '200.00',
    currency: 'MAD',
    billing: {
      first_name: 'Omar',
      last_name: 'C',
      phone: '212600000003'
    }
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-4'
    },
    payload: orderPayload
  });

  const replyPayload = { id: 'wa-2', from: '212600000003', text: '2' };
  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasender(replyPayload)
    },
    payload: replyPayload
  });

  assert.deepEqual(wooStatusCalls[0], { orderId: '104', status: 'cancelled' });
  assert.equal(store.getOrder('104').confirmationState, 'cancelled');
});

test('invalid reply keeps order pending and sends clarification once', async () => {
  const { app, wasenderCalls, store } = createTestContext();
  const orderPayload = {
    id: 105,
    status: 'pending',
    total: '70.00',
    currency: 'MAD',
    billing: {
      first_name: 'Aya',
      last_name: 'D',
      phone: '212600000004'
    }
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-5'
    },
    payload: orderPayload
  });

  const replyPayload = { id: 'wa-3', from: '212600000004', text: 'yes' };
  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasender(replyPayload)
    },
    payload: replyPayload
  });

  assert.equal(wasenderCalls.length, 2);
  assert.equal(store.getOrder('105').confirmationState, 'pending_confirmation');
  assert.equal(store.getOrder('105').clarificationSent, true);
});

test('bad signatures are rejected', async () => {
  const { app } = createTestContext();
  const wooResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': 'bad'
    },
    payload: { id: 106 }
  });
  const wasenderResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'bad'
    },
    payload: { id: 'wa-4', from: '212600000005', text: '1' }
  });

  assert.equal(wooResult.statusCode, 401);
  assert.equal(wasenderResult.statusCode, 401);
});
