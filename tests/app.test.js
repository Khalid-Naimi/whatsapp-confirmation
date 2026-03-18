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
  const wooOrderUpdates = [];
  const listedOrders = [];

  const wasenderClient = {
    async sendMessage(payload) {
      wasenderCalls.push(payload);
      return { id: `msg-${wasenderCalls.length}` };
    }
  };

  const wooClient = {
    async listOrders({ status, perPage = 100, page = 1 }) {
      const filtered = listedOrders.filter((order) => !status || order.status === status);
      const start = (page - 1) * perPage;
      return filtered.slice(start, start + perPage);
    },
    async updateOrder(orderId, fields) {
      wooOrderUpdates.push({ orderId, fields });
      const index = listedOrders.findIndex((order) => String(order.id) === String(orderId));
      const existing = index >= 0 ? listedOrders[index] : { id: orderId, meta_data: [] };
      const nextOrder = mergeOrder(existing, fields);
      if (index >= 0) {
        listedOrders[index] = nextOrder;
      }
      return nextOrder;
    },
    async updateOrderStatus(orderId, status) {
      wooStatusCalls.push({ orderId, status });
      return this.updateOrder(orderId, { status });
    },
    async updateOrderMeta(orderId, metaData) {
      return this.updateOrder(orderId, { meta_data: metaData });
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
      confirmationTemplate: 'Salam {{customerName}}, twsselna b la commande dyalk.\nNumero dyal La commande: {{orderId}}\nLa commande dyalk: {{orderItemsSummary}}\nPrix total: {{orderTotal}}\nLadresse: {{deliveryAddress}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nFach ghatwsl la commande dyalk lmdina dyalk, livreur ghay3eyet 3lik fhad numero dyal telephone, w tma t9dr tressi m3ah fin yji 3endek yjiblik la command, Lkhlas 3nd l-istilam.\n\n-Ila mtaf9 m3a had chi kaml, wbghiti tconfirmer la commande jawb b "1". \n-Ila ma bqitich bghiti la commande, jawb b "2".\n-Ila 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      invalidReply: '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      reminderMessage: 'Salam {{customerName}}, mazal ma jawbtinach 3la la commande dyalk numero {{orderId}}. 3afak jawb ghir b 1 bash t confirmer, wela b 2 bash t annuler.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
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
    tasks: {
      secret: 'task-secret'
    },
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

  return {
    app,
    store,
    wasenderCalls,
    wooStatusCalls,
    wooNoteCalls,
    wooOrderUpdates,
    listedOrders,
    confirmationService
  };
}

function mergeOrder(existingOrder, fields) {
  const nextOrder = {
    ...existingOrder,
    ...fields
  };

  if (fields.meta_data) {
    nextOrder.meta_data = mergeMetaData(existingOrder.meta_data || [], fields.meta_data);
  }

  return nextOrder;
}

function mergeMetaData(existingMeta, updates) {
  const merged = [...existingMeta];

  for (const update of updates) {
    const index = merged.findIndex((item) =>
      (update.id && item.id === update.id) ||
      item.key === update.key
    );
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        ...update
      };
    } else {
      merged.push(update);
    }
  }

  return merged;
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

function workflowMetaValue(metaData, key) {
  return metaData.find((item) => item.key === key)?.value;
}

test('new WooCommerce order sends one confirmation message and writes workflow meta', async () => {
  const { app, wasenderCalls, store, wooOrderUpdates } = createTestContext();
  const payload = {
    id: 101,
    status: 'pending',
    total: '150.00',
    currency: 'MAD',
    billing: {
      first_name: 'Khalid',
      last_name: 'Naimi',
      phone: '212612345678',
      address_1: '12 Rue Atlas',
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
  assert.match(wasenderCalls[0].message, /Ladresse: 12 Rue Atlas/);
  assert.match(wasenderCalls[0].message, /Lmdina: Casablanca/);
  assert.match(wasenderCalls[0].message, /Tawsil: 24h/);
  assert.match(wasenderCalls[0].message, /Ila 3endek chi question, seft la question dyalk l had numero: \+212 708-357533/);
  assert.equal(wooOrderUpdates.length, 1);
  const metaUpdate = wooOrderUpdates[0].fields.meta_data;
  assert.equal(workflowMetaValue(metaUpdate, 'rhymat_whatsapp_state'), 'pending');
  assert.equal(workflowMetaValue(metaUpdate, 'rhymat_whatsapp_reminder_count'), 0);
  assert.ok(workflowMetaValue(metaUpdate, 'rhymat_whatsapp_confirmation_sent_at'));
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
  const { app, wooStatusCalls, store, wasenderCalls, wooOrderUpdates } = createTestContext();
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
  const lastMetaUpdate = wooOrderUpdates.at(-1).fields.meta_data;
  assert.equal(workflowMetaValue(lastMetaUpdate, 'rhymat_whatsapp_state'), 'confirmed');
});

test('reply 2 cancels the order', async () => {
  const { app, wooStatusCalls, store, wasenderCalls, wooOrderUpdates } = createTestContext();
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
  const lastMetaUpdate = wooOrderUpdates.at(-1).fields.meta_data;
  assert.equal(workflowMetaValue(lastMetaUpdate, 'rhymat_whatsapp_state'), 'cancelled');
});

test('invalid reply sends clarification twice then goes manual', async () => {
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

  const secondReplyPayload = {
    data: {
      messages: {
        key: {
          remoteJid: '212600000004@s.whatsapp.net',
          fromMe: false
        },
        messageBody: 'safi'
      }
    }
  };
  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: secondReplyPayload
  });

  const thirdReplyPayload = {
    data: {
      messages: {
        key: {
          remoteJid: '212600000004@s.whatsapp.net',
          fromMe: false
        },
        messageBody: 'wach'
      }
    }
  };
  const thirdResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': 'wasender-secret'
    },
    payload: thirdReplyPayload
  });

  assert.equal(wasenderCalls.length, 3);
  assert.equal(store.getOrder('105').confirmationState, 'pending_confirmation');
  assert.equal(store.getOrder('105').invalidReplyCount, 2);
  assert.equal(store.getOrder('105').manualFollowupRequired, true);
  assert.equal(thirdResult.body.reason, 'manual_followup_required');
  assert.equal(
    wasenderCalls[1].message,
    '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533'
  );
  assert.equal(
    wasenderCalls[2].message,
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
  assert.match(wasenderCalls[0].message, /Ladresse: Ma kaynach/);
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

test('task endpoint rejects invalid task secret', async () => {
  const { app } = createTestContext();
  const result = await dispatch(app, {
    method: 'POST',
    url: '/tasks/order-followups',
    headers: {
      'x-task-secret': 'bad-secret'
    },
    payload: {}
  });

  assert.equal(result.statusCode, 401);
});

test('backfill sends confirmation only for processing orders without confirmation meta', async () => {
  const { confirmationService, wasenderCalls, listedOrders, wooNoteCalls } = createTestContext();
  listedOrders.push(
    {
      id: 201,
      status: 'processing',
      total: '220.00',
      currency: 'MAD',
      billing: {
        first_name: 'Backfill',
        last_name: 'One',
        phone: '0612345678',
        state: 'Casablanca',
        address_1: '1 Rue Backfill'
      },
      line_items: [{ name: 'Produit A', quantity: 1 }],
      meta_data: []
    },
    {
      id: 202,
      status: 'processing',
      total: '180.00',
      currency: 'MAD',
      billing: {
        first_name: 'Backfill',
        last_name: 'Two',
        phone: '0612345679',
        state: 'Rabat',
        address_1: '2 Rue Backfill'
      },
      line_items: [{ name: 'Produit B', quantity: 1 }],
      meta_data: [
        { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-18T08:00:00.000Z' },
        { key: 'rhymat_whatsapp_state', value: 'pending' },
        { key: 'rhymat_whatsapp_reminder_count', value: 0 }
      ]
    }
  );

  const summary = await confirmationService.runOrderFollowups({ backfillOnly: true, now: new Date('2026-03-18T10:00:00.000Z') });

  assert.equal(summary.backfilled, 1);
  assert.equal(wasenderCalls.length, 1);
  assert.match(wasenderCalls[0].message, /Numero dyal La commande: 201/);
  assert.equal(wooNoteCalls[0].note, 'WhatsApp confirmation backfill sent.');
});

test('hourly maintenance sends first and second reminders then auto-cancels after 72h', async () => {
  const { confirmationService, wasenderCalls, listedOrders, wooStatusCalls, wooNoteCalls } = createTestContext();

  listedOrders.push({
    id: 301,
    status: 'processing',
    total: '220.00',
    currency: 'MAD',
    billing: {
      first_name: 'Reminder',
      last_name: 'One',
      phone: '0611111111',
      state: 'Casablanca',
      address_1: '1 Rue Reminder'
    },
    line_items: [{ name: 'Produit R1', quantity: 1 }],
    meta_data: [
      { key: 'rhymat_whatsapp_state', value: 'pending' },
      { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-17T10:00:00.000Z' },
      { key: 'rhymat_whatsapp_reminder_count', value: 0 }
    ]
  });

  listedOrders.push({
    id: 302,
    status: 'processing',
    total: '230.00',
    currency: 'MAD',
    billing: {
      first_name: 'Reminder',
      last_name: 'Two',
      phone: '0622222222',
      state: 'Rabat',
      address_1: '2 Rue Reminder'
    },
    line_items: [{ name: 'Produit R2', quantity: 1 }],
    meta_data: [
      { key: 'rhymat_whatsapp_state', value: 'pending' },
      { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-16T09:00:00.000Z' },
      { key: 'rhymat_whatsapp_reminder_count', value: 1 }
    ]
  });

  listedOrders.push({
    id: 303,
    status: 'processing',
    total: '240.00',
    currency: 'MAD',
    billing: {
      first_name: 'Reminder',
      last_name: 'Three',
      phone: '0633333333',
      state: 'Marrakech',
      address_1: '3 Rue Reminder'
    },
    line_items: [{ name: 'Produit R3', quantity: 1 }],
    meta_data: [
      { key: 'rhymat_whatsapp_state', value: 'pending' },
      { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-15T08:00:00.000Z' },
      { key: 'rhymat_whatsapp_reminder_count', value: 2 }
    ]
  });

  const summary = await confirmationService.runOrderFollowups({ now: new Date('2026-03-18T10:00:00.000Z') });

  assert.equal(summary.remindersSent, 2);
  assert.equal(summary.autoCancelled, 1);
  assert.equal(wasenderCalls.length, 3);
  assert.match(wasenderCalls[0].message, /mazal ma jawbtinach 3la la commande dyalk numero 301/);
  assert.match(wasenderCalls[1].message, /mazal ma jawbtinach 3la la commande dyalk numero 302/);
  assert.equal(wasenderCalls[2].message, 'La commande dyalk t annulat.');
  assert.deepEqual(wooStatusCalls[0], { orderId: '303', status: 'cancelled' });
  assert.equal(wooNoteCalls.at(-1).note, 'Order auto-cancelled after 72h without WhatsApp confirmation.');
});

test('task endpoint runs followups with valid secret', async () => {
  const { app, listedOrders } = createTestContext();
  listedOrders.push({
    id: 401,
    status: 'processing',
    total: '260.00',
    currency: 'MAD',
    billing: {
      first_name: 'Task',
      last_name: 'Run',
      phone: '0644444444',
      state: 'Casablanca',
      address_1: '4 Rue Task'
    },
    line_items: [{ name: 'Produit T', quantity: 1 }],
    meta_data: []
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/tasks/order-followups',
    headers: {
      'x-task-secret': 'task-secret'
    },
    payload: {}
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.summary.backfilled, 1);
});
