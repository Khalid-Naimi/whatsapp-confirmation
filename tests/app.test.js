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
      confirmationTemplate: 'Salam {{customerName}}, twsselna b la commande dyalk.\nNumero dyal La commande: {{orderId}}\nLa commande dyalk: {{orderItemsSummary}}\nPrix total: {{orderTotal}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nFach ghatwsl la commande dyalk lmdina dyalk, livreur ghay3eyet 3lik fhad numero dyal telephone, w tma t9dr tressi m3ah fin yji 3endek yjiblik la command, Lkhlas 3nd l-istilam.\n\n-Ila mtaf9 m3a had chi kaml, wbghiti tconfirmer la commande jawb b "1". \n-Ila ma bqitich bghiti la commande, jawb b "2".\n-Ila 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      invalidReply: '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      confirmedReply: 'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.',
      cancelledReply: 'La commande dyalk t annulat.',
      deliveryEtaCasablanca: '24h',
      deliveryEtaOtherCities: '2 a 3 jours ouvrables',
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
      phone: '212612345678',
      state: 'Casablanca'
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
  assert.match(wasenderCalls[0].message, /Salam Khalid Naimi, twsselna b la commande dyalk\./);
  assert.match(wasenderCalls[0].message, /Numero dyal La commande: 101/);
  assert.match(wasenderCalls[0].message, /Gel Nettoyant x2, Creme x1/);
  assert.match(wasenderCalls[0].message, /Lmdina: Casablanca/);
  assert.match(wasenderCalls[0].message, /Tawsil: 24h/);
  assert.match(wasenderCalls[0].message, /Ila 3endek chi question, seft la question dyalk l had numero: \+212 708-357533/);
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
      phone: '212600000001',
      state: 'Rabat'
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

test('reply 1 confirms and updates WooCommerce to on-hold', async () => {
  const { app, wooStatusCalls, store, wasenderCalls } = createTestContext();
  const orderPayload = {
    id: 103,
    status: 'pending',
    total: '90.00',
    currency: 'MAD',
    billing: {
      first_name: 'Lina',
      last_name: 'B',
      phone: '212600000002',
      state: 'Casablanca'
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

  const replyPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212600000002',
          fromMe: false
        },
        messageBody: '1'
      }
    }
  };
  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 202);
  assert.deepEqual(wooStatusCalls[0], { orderId: '103', status: 'on-hold' });
  assert.equal(store.getOrder('103').confirmationState, 'confirmed');
  assert.equal(
    wasenderCalls[1].message,
    'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.'
  );
});

test('reply 2 cancels the order', async () => {
  const { app, wooStatusCalls, store, wasenderCalls } = createTestContext();
  const orderPayload = {
    id: 104,
    status: 'pending',
    total: '200.00',
    currency: 'MAD',
    billing: {
      first_name: 'Omar',
      last_name: 'C',
      phone: '212600000003',
      state: 'Marrakech'
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

  const replyPayload = {
    data: {
      messages: {
        key: {
          senderPn: '212600000003',
          fromMe: false
        },
        message: {
          conversation: '2'
        }
      }
    }
  };
  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: replyPayload
  });

  assert.deepEqual(wooStatusCalls[0], { orderId: '104', status: 'cancelled' });
  assert.equal(store.getOrder('104').confirmationState, 'cancelled');
  assert.equal(wasenderCalls[1].message, 'La commande dyalk t annulat.');
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
      phone: '212600000004',
      state: 'Rabat'
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

  const replyPayload = {
    data: {
      messages: {
        key: {
          remoteJid: '212600000004@s.whatsapp.net',
          fromMe: false
        },
        messageBody: 'yes'
      }
    }
  };
  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: replyPayload
  });

  assert.equal(wasenderCalls.length, 2);
  assert.equal(store.getOrder('105').confirmationState, 'pending_confirmation');
  assert.equal(store.getOrder('105').clarificationSent, true);
  assert.equal(
    wasenderCalls[1].message,
    '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533'
  );
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
      state: 'Agadir'
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

  assert.match(wasenderCalls[0].message, /Tawsil: 2 a 3 jours ouvrables/);
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
      phone: '212600000007',
      state: 'Casa'
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

  assert.match(wasenderCalls[0].message, /Tawsil: 2 a 3 jours ouvrables/);
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
  assert.match(wasenderCalls[0].message, /Tawsil: 2 a 3 jours ouvrables/);
});

test('message without pending order is flagged as manual and gets no reply', async () => {
  const { app, store, wasenderCalls } = createTestContext();
  const replyPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212600000009',
          fromMe: false
        },
        messageBody: 'Salam'
      }
    }
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 202);
  assert.equal(wasenderCalls.length, 0);
  const db = store.read();
  assert.equal(db.events.at(-1).status, 'manual_followup_required');
});

test('bot-originated Wasender events are ignored', async () => {
  const { app, wasenderCalls } = createTestContext();
  const replyPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212600000010',
          fromMe: true
        },
        messageBody: '1'
      }
    }
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 202);
  assert.equal(wasenderCalls.length, 0);
  assert.equal(result.body.ignored, true);
});
