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
      confirmationTemplate: 'Salam {{customerName}}, twsselna b talab dyalk.\nNumiro dyal talab: {{orderId}}\nTalab dyalk: {{orderItemsSummary}}\nTaman l-kolli: {{orderTotal}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nLkhlas 3nd l-istilam.\nIla mtaf9 m3a had chi kaml, rdd b 1. Ila ma bqitich bghiti talab, rdd b 2.',
      invalidReply: 'Afak rdd ghir b 1 bash t2akked talab, wela b 2 ila ma bqitihch.',
      deliveryEtaCasablanca: '24h',
      deliveryEtaOtherCities: '2 to 3 business days',
      defaultCityLabel: 'Maghrib'
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
    },
    shipping: {
      city: 'Casablanca'
    },
    line_items: [
      { name: 'Gel Nettoyant', quantity: 2 },
      { name: 'Creme', quantity: 1 }
    ]
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
  assert.match(wasenderCalls[0].message, /Gel Nettoyant x2, Creme x1/);
  assert.match(wasenderCalls[0].message, /Lmdina: Casablanca/);
  assert.match(wasenderCalls[0].message, /Tawsil: 24h/);
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
    },
    shipping: {
      city: 'Rabat'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
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
    },
    shipping: {
      city: 'Casablanca'
    },
    line_items: [{ name: 'Savon', quantity: 1 }]
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
    },
    shipping: {
      city: 'Marrakech'
    },
    line_items: [{ name: 'Pack', quantity: 3 }]
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
    },
    shipping: {
      city: 'Rabat'
    },
    line_items: [{ name: 'Huile', quantity: 1 }]
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
  assert.equal(wasenderCalls[1].message, 'Afak rdd ghir b 1 bash t2akked talab, wela b 2 ila ma bqitihch.');
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

test('non-Casablanca city uses 2 to 3 business days', async () => {
  const { app, wasenderCalls } = createTestContext();
  const payload = {
    id: 107,
    status: 'pending',
    total: '120.00',
    currency: 'MAD',
    billing: {
      first_name: 'Nora',
      last_name: 'E',
      phone: '212600000006',
      city: 'Agadir'
    },
    line_items: [{ name: 'Masque', quantity: 2 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-7'
    },
    payload
  });

  assert.match(wasenderCalls[0].message, /Tawsil: 2 to 3 business days/);
});

test('city match is exact so Casa does not get 24h', async () => {
  const { app, wasenderCalls } = createTestContext();
  const payload = {
    id: 108,
    status: 'pending',
    total: '130.00',
    currency: 'MAD',
    billing: {
      first_name: 'Yassine',
      last_name: 'F',
      phone: '212600000007'
    },
    shipping: {
      city: 'Casa'
    },
    line_items: [{ name: 'Spray', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-8'
    },
    payload
  });

  assert.match(wasenderCalls[0].message, /Tawsil: 2 to 3 business days/);
});

test('missing city uses fallback label and non-Casablanca eta', async () => {
  const { app, wasenderCalls } = createTestContext();
  const payload = {
    id: 109,
    status: 'pending',
    total: '140.00',
    currency: 'MAD',
    billing: {
      first_name: 'Salma',
      last_name: 'G',
      phone: '212600000008'
    },
    line_items: [{ name: 'Brosse', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-9'
    },
    payload
  });

  assert.match(wasenderCalls[0].message, /Lmdina: Maghrib/);
  assert.match(wasenderCalls[0].message, /Tawsil: 2 to 3 business days/);
});
