import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { JsonStore } from '../src/json-store.js';
import { ConfirmationService } from '../src/services/confirmation-service.js';
import { WasenderSendError } from '../src/services/wasender-client.js';
import { normalizePhone, validatePhone } from '../src/utils/format.js';

function createTestContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woo-confirmation-'));
  const dataFile = path.join(tmpDir, 'db.json');
  const store = new JsonStore(dataFile);

  const wasenderCalls = [];
  const mailCalls = [];
  const wooStatusCalls = [];
  const wooNoteCalls = [];
  const wooOrderUpdates = [];
  const listedOrders = [];
  const logCalls = [];

  const logger = {
    log(message) {
      logCalls.push(`log:${message}`);
    },
    warn(message) {
      logCalls.push(`warn:${message}`);
    },
    error(message) {
      logCalls.push(`error:${message?.message || message}`);
    }
  };

  const wasenderClient = {
    async sendMessage(payload) {
      wasenderCalls.push(payload);
      return { id: `msg-${wasenderCalls.length}` };
    }
  };

  const wooClient = {
    async listOrdersByStatuses(statuses, { perPage = 100 } = {}) {
      const allOrders = [];
      const seenOrderIds = new Set();

      for (const status of statuses) {
        let page = 1;

        while (true) {
          const orders = await this.listOrders({ status, perPage, page });
          if (!orders.length) {
            break;
          }

          for (const order of orders) {
            const orderId = String(order.id);
            if (seenOrderIds.has(orderId)) {
              continue;
            }

            seenOrderIds.add(orderId);
            allOrders.push(order);
          }

          if (orders.length < perPage) {
            break;
          }
          page += 1;
        }
      }

      return allOrders;
    },
    async listOrders({ status, perPage = 100, page = 1 }) {
      const filtered = listedOrders.filter((order) => !status || order.status === status);
      const start = (page - 1) * perPage;
      return filtered.slice(start, start + perPage);
    },
    async getOrder(orderId) {
      const order = listedOrders.find((item) => String(item.id) === String(orderId));
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }
      return order;
    },
    async updateOrder(orderId, fields) {
      wooOrderUpdates.push({ orderId, fields });
      const index = listedOrders.findIndex((order) => String(order.id) === String(orderId));
      const existing = index >= 0 ? listedOrders[index] : { id: orderId, meta_data: [] };
      const nextOrder = mergeOrder(existing, fields);
      if (index >= 0) {
        listedOrders[index] = nextOrder;
      } else {
        listedOrders.push(nextOrder);
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

  const mailService = {
    async send(payload) {
      mailCalls.push(payload);
      return { id: `mail-${mailCalls.length}` };
    }
  };

  const confirmationService = new ConfirmationService({
    store,
    wasenderClient,
    wooClient,
    mailService,
    messages: {
      confirmationTemplate: 'Salam {{customerName}}, twsselna b la commande dyalk.\nNumero dyal La commande: {{orderId}}\nLa commande dyalk: {{orderItemsSummary}}\nPrix total: {{orderTotal}}\nLadresse: {{deliveryAddress}}\nLmdina: {{deliveryCity}}\nTawsil: {{deliveryEta}}\nFach ghatwsl la commande dyalk lmdina dyalk, livreur ghay3eyet 3lik fhad numero dyal telephone, w tma t9dr tressi m3ah fin yji 3endek yjiblik la command, Lkhlas 3nd l-istilam.\n\n-Ila mtaf9 m3a had chi kaml, wbghiti tconfirmer la commande jawb b "1". \n-Ila ma bqitich bghiti la commande, jawb b "2".\n-Ila 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      invalidReply: '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      reminderMessage: 'Salam {{customerName}}, mazal ma jawbtinach 3la la commande dyalk numero {{orderId}}. 3afak jawb ghir b 1 bash t confirmer, wela b 2 bash t annuler.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533',
      confirmedReply: 'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.',
      cancelledReply: 'La commande dyalk t annulat.',
      cancellationEmailSubject: 'Your order #{{orderId}} has been cancelled',
      cancellationEmailBody: 'Salam {{customerName}},\n\nWe were unable to confirm your order because the phone number provided appears to be incorrect or not connected to WhatsApp.\n\nFor that reason, your order #{{orderId}} has been cancelled.\n\nIf you would still like to receive your order, please place a new order using a valid phone number that is reachable on WhatsApp.\n\nThank you for your understanding.',
      internalNotifyPhones: ['+212708357533', '+491729031097'],
      internalConfirmedTemplate: 'Commande confirmat.\nClient: {{customerName}}\nNumero: {{orderId}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      internalCancelledTemplate: 'Commande annulat.\nClient: {{customerName}}\nNumero: {{orderId}}\nTelephone: {{customerPhone}}\nVille: {{deliveryCity}}\nAdresse: {{deliveryAddress}}\nTalab: {{orderItemsSummary}}\nTotal: {{orderTotal}}',
      deliveryEtaCasablanca: '24h',
      deliveryEtaOtherCities: '2 a 3 jours ouvrables',
      defaultCityLabel: 'Maghrib'
    },
    logger
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
    store,
    logger
  });

  return {
    app,
    store,
    wasenderCalls,
    mailCalls,
    wooStatusCalls,
    wooNoteCalls,
    wooOrderUpdates,
    listedOrders,
    confirmationService,
    logCalls
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

function signWasenderPlain(secret = 'wasender-secret') {
  return secret;
}

function signWasenderHmac(payload, secret = 'wasender-secret') {
  return createHmac('md5', secret).update(JSON.stringify(payload)).digest('hex');
}

function workflowMetaValue(metaData, key) {
  return metaData.find((item) => item.key === key)?.value;
}

function buildWorkflowMeta({
  state = '',
  confirmationSentAt = '',
  reminderCount,
  lastReminderAt = '',
  cancelledAt = ''
} = {}) {
  return [
    { key: 'rhymat_whatsapp_state', value: state },
    { key: 'rhymat_whatsapp_confirmation_sent_at', value: confirmationSentAt },
    ...(reminderCount === undefined ? [] : [{ key: 'rhymat_whatsapp_reminder_count', value: reminderCount }]),
    { key: 'rhymat_whatsapp_last_reminder_at', value: lastReminderAt },
    { key: 'rhymat_whatsapp_cancelled_at', value: cancelledAt }
  ].filter((item) => item.value !== '');
}

function buildDecisionMeta({
  decision = '',
  decisionAt = '',
  wooSyncStatus = '',
  wooSyncAttempts,
  lastSyncError = '',
  customerReplySent = '',
  manualOverride = '',
  manualOverrideAt = '',
  manualOverrideStatus = ''
} = {}) {
  return [
    { key: 'rhymat_whatsapp_decision', value: decision },
    { key: 'rhymat_whatsapp_decision_at', value: decisionAt },
    { key: 'rhymat_whatsapp_woo_sync_status', value: wooSyncStatus },
    ...(wooSyncAttempts === undefined ? [] : [{ key: 'rhymat_whatsapp_woo_sync_attempts', value: wooSyncAttempts }]),
    { key: 'rhymat_whatsapp_last_sync_error', value: lastSyncError },
    { key: 'rhymat_whatsapp_customer_reply_sent', value: customerReplySent },
    { key: 'rhymat_whatsapp_manual_override', value: manualOverride },
    { key: 'rhymat_whatsapp_manual_override_at', value: manualOverrideAt },
    { key: 'rhymat_whatsapp_manual_override_status', value: manualOverrideStatus }
  ].filter((item) => item.value !== '');
}

function buildFeedbackMeta({
  state = '',
  replyAt = '',
  replyLastMessageId = '',
  replyCount,
  senderPhone = '',
  lastKind = '',
  lastText = '',
  lastCaption = '',
  lastMediaUrl = '',
  lastMimeType = '',
  payloadJson = '',
  token = '',
  testPhone = '',
  testActive = '',
  isTest = '',
  testRunId = '',
  requestedAt = '',
  sentAt = ''
} = {}) {
  return [
    { key: 'rhymat_feedback_state', value: state },
    { key: 'rhymat_feedback_reply_at', value: replyAt },
    { key: 'rhymat_feedback_reply_last_message_id', value: replyLastMessageId },
    ...(replyCount === undefined ? [] : [{ key: 'rhymat_feedback_reply_count', value: replyCount }]),
    { key: 'rhymat_feedback_sender_phone', value: senderPhone },
    { key: 'rhymat_feedback_last_kind', value: lastKind },
    { key: 'rhymat_feedback_last_text', value: lastText },
    { key: 'rhymat_feedback_last_caption', value: lastCaption },
    { key: 'rhymat_feedback_last_media_url', value: lastMediaUrl },
    { key: 'rhymat_feedback_last_mime_type', value: lastMimeType },
    { key: 'rhymat_feedback_payload_json', value: payloadJson },
    { key: 'rhymat_feedback_token', value: token },
    { key: 'rhymat_feedback_test_phone', value: testPhone },
    { key: 'rhymat_feedback_test_active', value: testActive },
    { key: 'rhymat_feedback_is_test', value: isTest },
    { key: 'rhymat_feedback_test_run_id', value: testRunId },
    { key: 'rhymat_feedback_requested_at', value: requestedAt },
    { key: 'rhymat_feedback_sent_at', value: sentAt }
  ].filter((item) => item.value !== '');
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

test('feedback self-test Woo order skips confirmation send and records skip status', async () => {
  const { app, store, wasenderCalls, wooOrderUpdates, wooNoteCalls } = createTestContext();
  const payload = {
    id: 10201,
    status: 'pending',
    total: '0.00',
    currency: 'EUR',
    billing: {
      first_name: 'Self',
      last_name: 'Test',
      phone: '+491729031097',
      state: 'Berlin'
    },
    line_items: [{ name: 'Feedback Self Test', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      token: 'FDBK-TEST-20260420T102451Z-BTIAIB',
      testPhone: '+491729031097',
      testActive: 'yes',
      isTest: 'yes',
      testRunId: 'selftest-20260420T102451Z-btiaib',
      requestedAt: '2026-04-20T10:25:23Z',
      sentAt: '2026-04-20T10:25:23Z'
    })
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-self-test-skip-10201'
    },
    payload
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, skipped: true, reason: 'feedback_self_test' });
  assert.equal(wasenderCalls.length, 0);
  assert.equal(wooOrderUpdates.length, 0);
  assert.equal(wooNoteCalls.length, 0);
  assert.equal(store.read().events.at(-1).status, 'feedback_self_test_skipped_confirmation');
  assert.equal(store.getOrder('10201'), null);
});

test('invalid or non-WhatsApp number auto-cancels the order and sends email', async () => {
  const { app, store, mailCalls, wooStatusCalls, wooNoteCalls, confirmationService, logCalls } = createTestContext();
  const payload = {
    id: 1021,
    status: 'pending',
    total: '100.00',
    currency: 'MAD',
    billing: {
      first_name: 'Sara',
      last_name: 'Email',
      phone: '212600000021',
      email: 'sara@example.com',
      state: 'Rabat'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  confirmationService.wasenderClient.sendMessage = async () => {
    throw new WasenderSendError({
      status: 422,
      data: { message: 'Recipient not registered on WhatsApp' },
      message: 'Wasender send-message failed with 422: {"message":"Recipient not registered on WhatsApp"}'
    });
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-1021'
    },
    payload
  });

  assert.equal(result.statusCode, 202);
  assert.equal(result.body.reason, 'invalid_or_non_whatsapp_number');
  assert.deepEqual(wooStatusCalls[0], { orderId: '1021', status: 'cancelled' });
  assert.equal(store.getOrder('1021').confirmationState, 'cancelled');
  assert.equal(store.getOrder('1021').cancellationReason, 'invalid_or_non_whatsapp_number');
  assert.equal(store.getOrder('1021').customerEmailStatus, 'sent');
  assert.equal(mailCalls.length, 1);
  assert.equal(mailCalls[0].to, 'sara@example.com');
  assert.equal(mailCalls[0].subject, 'Your order #1021 has been cancelled');
  assert.match(mailCalls[0].text, /incorrect or not connected to WhatsApp/);
  assert.match(wooNoteCalls[0].note, /Customer email notification sent/);
  assert.ok(logCalls.some((item) => item.includes('classified invalid_or_non_whatsapp_number orderId=1021')));
  assert.ok(logCalls.some((item) => item.includes('cancel completed orderId=1021 emailStatus=sent')));
});

test('malformed phone auto-cancels before Wasender send', async () => {
  const { app, store, wasenderCalls, mailCalls, wooStatusCalls, wooNoteCalls, logCalls } = createTestContext();
  const payload = {
    id: 10215,
    status: 'pending',
    total: '100.00',
    currency: 'MAD',
    billing: {
      first_name: 'Bad',
      last_name: 'Prefix',
      phone: '123',
      email: 'badprefix@example.com',
      state: 'Rabat'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-10215'
    },
    payload
  });

  assert.equal(result.statusCode, 202);
  assert.equal(result.body.reason, 'invalid_or_non_whatsapp_number');
  assert.equal(wasenderCalls.length, 0);
  assert.equal(mailCalls.length, 1);
  assert.deepEqual(wooStatusCalls[0], { orderId: '10215', status: 'cancelled' });
  assert.equal(store.getOrder('10215').cancellationReason, 'invalid_or_non_whatsapp_number');
  assert.match(wooNoteCalls[0].note, /invalid or not reachable on WhatsApp/);
  assert.ok(logCalls.some((item) => item.includes('classified invalid_or_non_whatsapp_number orderId=10215 reason=invalid_phone')));
});

test('valid non-Moroccan E.164 number is sent without pre-cancellation', async () => {
  const { app, store, wasenderCalls, wooStatusCalls } = createTestContext();
  const payload = {
    id: 10216,
    status: 'pending',
    total: '100.00',
    currency: 'EUR',
    billing: {
      first_name: 'Paris',
      last_name: 'Customer',
      phone: '+33612345678',
      email: 'paris@example.com',
      state: 'Paris'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-10216'
    },
    payload
  });

  assert.equal(result.statusCode, 202);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(wasenderCalls.length, 1);
  assert.equal(wasenderCalls[0].to, '+33612345678');
  assert.equal(wooStatusCalls.length, 0);
  assert.equal(store.getOrder('10216').confirmationState, 'pending_confirmation');
});

test('00-prefixed international number is normalized to E.164 before send', async () => {
  const { app, wasenderCalls, wooStatusCalls } = createTestContext();
  const payload = {
    id: 10217,
    status: 'pending',
    total: '100.00',
    currency: 'EUR',
    billing: {
      first_name: 'Paris',
      last_name: 'DialCode',
      phone: '0033612345678',
      email: 'dialcode@example.com',
      state: 'Paris'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-10217'
    },
    payload
  });

  assert.equal(result.statusCode, 202);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(wasenderCalls.length, 1);
  assert.equal(wasenderCalls[0].to, '+33612345678');
  assert.equal(wooStatusCalls.length, 0);
});

test('invalid or non-WhatsApp number still cancels when billing email is missing', async () => {
  const { app, store, mailCalls, wooStatusCalls, wooNoteCalls, confirmationService } = createTestContext();
  const payload = {
    id: 1022,
    status: 'pending',
    total: '100.00',
    currency: 'MAD',
    billing: {
      first_name: 'No',
      last_name: 'Email',
      phone: '212600000022',
      state: 'Rabat'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  confirmationService.wasenderClient.sendMessage = async () => {
    throw new WasenderSendError({
      status: 400,
      data: { error: 'invalid phone number' },
      message: 'Wasender send-message failed with 400: {"error":"invalid phone number"}'
    });
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-1022'
    },
    payload
  });

  assert.deepEqual(wooStatusCalls[0], { orderId: '1022', status: 'cancelled' });
  assert.equal(store.getOrder('1022').customerEmailStatus, 'skipped');
  assert.equal(mailCalls.length, 0);
  assert.match(wooNoteCalls[0].note, /notification skipped/);
});

test('invalid or non-WhatsApp number still cancels when email sending fails', async () => {
  const { app, store, wooStatusCalls, wooNoteCalls, confirmationService } = createTestContext();
  const payload = {
    id: 1023,
    status: 'pending',
    total: '100.00',
    currency: 'MAD',
    billing: {
      first_name: 'Mail',
      last_name: 'Fail',
      phone: '212600000023',
      email: 'mailfail@example.com',
      state: 'Rabat'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  confirmationService.wasenderClient.sendMessage = async () => {
    throw new WasenderSendError({
      status: 404,
      data: { message: 'Recipient unreachable' },
      message: 'Wasender send-message failed with 404: {"message":"Recipient unreachable"}'
    });
  };
  confirmationService.mailService.send = async () => {
    throw new Error('smtp authentication failed');
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-1023'
    },
    payload
  });

  assert.deepEqual(wooStatusCalls[0], { orderId: '1023', status: 'cancelled' });
  assert.equal(store.getOrder('1023').customerEmailStatus, 'failed');
  assert.equal(store.getOrder('1023').customerEmailError, 'smtp authentication failed');
  assert.match(wooNoteCalls[0].note, /notification failed/);
});

test('generic Wasender failure still uses send_failed without auto-cancelling', async () => {
  const { app, store, wooStatusCalls, mailCalls, confirmationService, logCalls } = createTestContext();
  const payload = {
    id: 1024,
    status: 'pending',
    total: '100.00',
    currency: 'MAD',
    billing: {
      first_name: 'Gateway',
      last_name: 'Error',
      phone: '212600000024',
      email: 'gateway@example.com',
      state: 'Rabat'
    },
    line_items: [{ name: 'Produit', quantity: 1 }]
  };

  confirmationService.wasenderClient.sendMessage = async () => {
    throw new WasenderSendError({
      status: 500,
      data: { message: 'gateway error' },
      message: 'Wasender send-message failed with 500: {"message":"gateway error"}'
    });
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(payload),
      'x-wc-webhook-delivery-id': 'delivery-1024'
    },
    payload
  });

  assert.equal(result.statusCode, 502);
  assert.equal(result.body.reason, 'send_failed');
  assert.equal(store.getOrder('1024').confirmationState, 'send_failed');
  assert.equal(wooStatusCalls.length, 0);
  assert.equal(mailCalls.length, 0);
  assert.ok(logCalls.some((item) => item.includes('classified send_failed orderId=1024')));
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
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 200);
  const confirmStatusUpdate = wooOrderUpdates.find((u) => u.fields.status);
  assert.equal(confirmStatusUpdate?.orderId, '103');
  assert.equal(confirmStatusUpdate?.fields.status, 'on-hold');
  assert.equal(store.getOrder('103').confirmationState, 'confirmed');
  assert.equal(
    wasenderCalls[1].message,
    'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.'
  );
  assert.equal(wasenderCalls[2].to, '+212708357533');
  assert.equal(wasenderCalls[3].to, '+491729031097');
  assert.match(wasenderCalls[2].message, /Commande confirmat/);
  assert.equal(store.getOrder('103').confirmationState, 'confirmed');
  assert.equal(store.getOrder('103').decision, 'confirmed');
  assert.equal(store.getOrder('103').wooSyncStatus, 'synced');
  assert.equal(store.getOrder('103').customerReplySent, 'yes');
  assert.equal(store.getOrder('103').internalNotifiedConfirmed, 'yes');
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
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  const cancelStatusUpdate = wooOrderUpdates.find((u) => u.fields.status);
  assert.equal(cancelStatusUpdate?.orderId, '104');
  assert.equal(cancelStatusUpdate?.fields.status, 'cancelled');
  assert.equal(store.getOrder('104').confirmationState, 'cancelled');
  assert.equal(wasenderCalls[1].message, 'La commande dyalk t annulat.');
  assert.equal(wasenderCalls[2].to, '+212708357533');
  assert.equal(wasenderCalls[3].to, '+491729031097');
  assert.match(wasenderCalls[2].message, /Commande annulat/);
  assert.equal(store.getOrder('104').confirmationState, 'cancelled');
  assert.equal(store.getOrder('104').decision, 'cancelled');
  assert.equal(store.getOrder('104').wooSyncStatus, 'synced');
  assert.equal(store.getOrder('104').customerReplySent, 'yes');
  assert.equal(store.getOrder('104').internalNotifiedCancelled, 'yes');
});

test('replayed final reply does not send duplicate customer follow-up', async () => {
  const { app, wasenderCalls } = createTestContext();
  const orderPayload = {
    id: 111,
    status: 'pending',
    total: '120.00',
    currency: 'MAD',
    billing: {
      first_name: 'Replay',
      last_name: 'One',
      phone: '212600000012',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Replay', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-11'
    },
    payload: orderPayload
  });

  const replyPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212600000012',
          fromMe: false
        },
        messageBody: '1'
      }
    }
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  const replayResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'replay-final-1'
    },
    payload: replyPayload
  });

  assert.equal(replayResult.statusCode, 200);
  assert.equal(wasenderCalls.length, 4);
  assert.equal(replayResult.body.duplicates, 1);
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
      'x-wasender-signature': signWasenderPlain()
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
      'x-wasender-signature': signWasenderPlain()
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
      'x-wasender-signature': signWasenderPlain()
    },
    payload: thirdReplyPayload
  });

  assert.equal(wasenderCalls.length, 3);
  assert.equal(store.getOrder('105').confirmationState, 'pending_confirmation');
  assert.equal(store.getOrder('105').invalidReplyCount, 2);
  assert.equal(store.getOrder('105').manualFollowupRequired, true);
  assert.equal(thirdResult.body.ignored, 1);
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
  const wasenderPayload = { id: 'wa-4', from: '212600000005', text: '1' };
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
    payload: wasenderPayload
  });
  const wasenderHmacResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderHmac(wasenderPayload, 'wrong-secret')
    },
    payload: wasenderPayload
  });
  const wasenderMissingHeaderResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    payload: wasenderPayload
  });

  assert.equal(wooResult.statusCode, 401);
  assert.equal(wasenderResult.statusCode, 401);
  assert.equal(wasenderHmacResult.statusCode, 401);
  assert.equal(wasenderMissingHeaderResult.statusCode, 401);
});

test('legacy Wasender HMAC signature is still accepted', async () => {
  const { app } = createTestContext();
  const payload = { id: 'wa-4b', from: '212600000005', text: '1' };
  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderHmac(payload)
    },
    payload
  });

  assert.equal(result.statusCode, 200);
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

test('message without pending order is ignored as unmatched and gets no reply', async () => {
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
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 200);
  assert.equal(wasenderCalls.length, 0);
  const db = store.read();
  assert.equal(db.events.at(-1).status, 'unmatched_inbound');
});

test('reply recovers pending order from Woo after local cache loss and blocks follow-up reminders', async () => {
  const initialContext = createTestContext();
  const orderPayload = {
    id: 112,
    status: 'pending',
    total: '125.00',
    currency: 'MAD',
    billing: {
      first_name: 'Recover',
      last_name: 'Cache',
      phone: '+212612345681',
      state: 'Casablanca',
      address_1: '12 Rue Recover'
    },
    line_items: [{ name: 'Produit Recover', quantity: 1 }],
    date_created_gmt: '2026-03-18T08:00:00'
  };

  initialContext.listedOrders.push(structuredClone(orderPayload));

  await dispatch(initialContext.app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-recover-1'
    },
    payload: orderPayload
  });

  const restartedContext = createTestContext();
  restartedContext.listedOrders.push(...structuredClone(initialContext.listedOrders));

  const replyResult = await dispatch(restartedContext.app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain()
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '212612345681',
            fromMe: false
          },
          messageBody: '1'
        }
      }
    }
  });

  assert.equal(replyResult.statusCode, 200);
  assert.equal(restartedContext.store.getOrder('112').confirmationState, 'confirmed');
  assert.equal(restartedContext.store.read().events.at(-1).status, 'matched_via_woo_fallback');
  const recoverStatusUpdate = restartedContext.wooOrderUpdates.find((u) => u.fields.status);
  assert.equal(recoverStatusUpdate?.orderId, '112');
  assert.equal(recoverStatusUpdate?.fields.status, 'on-hold');
  assert.equal(restartedContext.wasenderCalls.length, 3);

  const summary = await restartedContext.confirmationService.runOrderFollowups({
    now: new Date('2026-03-20T10:00:00.000Z')
  });

  assert.equal(summary.remindersSent, 0);
  assert.equal(restartedContext.wasenderCalls.length, 3);
});

test('Woo fallback picks the newest pending order for the same phone', async () => {
  const { app, store, listedOrders, wooOrderUpdates } = createTestContext();

  listedOrders.push(
    {
      id: 501,
      status: 'processing',
      total: '100.00',
      currency: 'MAD',
      billing: {
        first_name: 'Older',
        last_name: 'Pending',
        phone: '+212612345682',
        state: 'Casablanca'
      },
      line_items: [{ name: 'Produit Old', quantity: 1 }],
      date_created_gmt: '2026-03-18T08:00:00',
      meta_data: [
        { key: 'rhymat_whatsapp_state', value: 'pending' },
        { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-18T08:30:00.000Z' },
        { key: 'rhymat_whatsapp_reminder_count', value: 0 }
      ]
    },
    {
      id: 502,
      status: 'processing',
      total: '110.00',
      currency: 'MAD',
      billing: {
        first_name: 'Newer',
        last_name: 'Pending',
        phone: '+212612345682',
        state: 'Casablanca'
      },
      line_items: [{ name: 'Produit New', quantity: 1 }],
      date_created_gmt: '2026-03-19T08:00:00',
      meta_data: [
        { key: 'rhymat_whatsapp_state', value: 'pending' },
        { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-19T08:30:00.000Z' },
        { key: 'rhymat_whatsapp_reminder_count', value: 0 }
      ]
    }
  );

  const replyResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain()
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '212612345682',
            fromMe: false
          },
          messageBody: '2'
        }
      }
    }
  });

  assert.equal(replyResult.statusCode, 200);
  const fallbackStatusUpdate = wooOrderUpdates.find((u) => u.fields.status);
  assert.equal(fallbackStatusUpdate?.orderId, '502');
  assert.equal(fallbackStatusUpdate?.fields.status, 'cancelled');
  assert.equal(store.getOrder('502').confirmationState, 'cancelled');
  assert.equal(store.getOrder('501'), null);
});

test('audio reply with pending order is treated like invalid input', async () => {
  const { app, wasenderCalls, store } = createTestContext();
  const orderPayload = {
    id: 110,
    status: 'pending',
    total: '150.00',
    currency: 'MAD',
    billing: {
      first_name: 'Audio',
      last_name: 'Pending',
      phone: '+212612345680',
      state: 'Casablanca',
      address_1: '10 Rue Audio'
    },
    line_items: [{ name: 'Produit Audio', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-audio-1'
    },
    payload: orderPayload
  });

  const audioPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212612345680',
          fromMe: false
        },
        message: {
          audioMessage: {
            mimetype: 'audio/ogg'
          }
        }
      }
    }
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain()
    },
    payload: audioPayload
  });

  assert.equal(result.statusCode, 200);
  assert.equal(wasenderCalls.length, 2);
  assert.equal(
    wasenderCalls[1].message,
    '3afak jawb ghir b 1 bash t confirmer la commande, wela b 2 bach t annuler la commande.\n\nIla 3endek chi question, seft la question dyalk l had numero: +212 708-357533'
  );
  assert.equal(store.getOrder('110').invalidReplyCount, 1);
});

test('audio reply without pending order is ignored and gets no reply', async () => {
  const { app, store, wasenderCalls } = createTestContext();
  const audioPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212600000011',
          fromMe: false
        },
        message: {
          audioMessage: {
            mimetype: 'audio/ogg'
          }
        }
      }
    }
  };

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain()
    },
    payload: audioPayload
  });

  assert.equal(result.statusCode, 200);
  assert.equal(wasenderCalls.length, 0);
  const db = store.read();
  assert.equal(db.events.at(-1).status, 'unmatched_inbound');
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
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 200);
  assert.equal(wasenderCalls.length, 0);
  assert.equal(result.body.ignored, 1);
});

test('batch payload processes confirmation and feedback independently', async () => {
  const { app, store, listedOrders, wooOrderUpdates, wooNoteCalls } = createTestContext();

  const confirmationOrder = {
    id: 701,
    status: 'pending',
    total: '90.00',
    currency: 'MAD',
    billing: {
      first_name: 'Batch',
      last_name: 'Confirm',
      phone: '+212611111701',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Confirm', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(confirmationOrder),
      'x-wc-webhook-delivery-id': 'delivery-batch-confirm-701'
    },
    payload: confirmationOrder
  });

  listedOrders.push({
    id: 801,
    status: 'completed',
    total: '120.00',
    currency: 'MAD',
    billing: {
      first_name: 'Batch',
      last_name: 'Feedback',
      phone: '+212611111801',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Feedback', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      replyCount: 0
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'wasender-batch-1'
    },
    payload: {
      data: {
        messages: [
          {
            key: {
              cleanedSenderPn: '212611111701',
              fromMe: false
            },
            messageBody: '1'
          },
          {
            key: {
              cleanedSenderPn: '212611111801',
              fromMe: false,
              id: 'feedback-batch-801'
            },
            message: {
              imageMessage: {
                caption: 'FDBK-801 very good',
                mimetype: 'image/jpeg',
                url: 'https://cdn.example.com/801.jpg'
              }
            }
          }
        ]
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.processed, 2);
  assert.equal(result.body.confirmation, 1);
  assert.equal(result.body.feedback, 1);
  assert.equal(store.getOrder('701').confirmationState, 'confirmed');
  const feedbackMeta = workflowMetaValue(
    listedOrders.find((order) => String(order.id) === '801').meta_data,
    'rhymat_feedback_state'
  );
  assert.equal(feedbackMeta, 'reply_received');
  assert.ok(wooOrderUpdates.some((update) => update.orderId === '701' && update.fields.status === 'on-hold'));
  assert.ok(wooNoteCalls.some((note) => note.orderId === '801' && /\[image\]/.test(note.note)));
});

test('mixed batch with one unusable message still processes the usable message', async () => {
  const { app, listedOrders, wooNoteCalls } = createTestContext();
  listedOrders.push({
    id: 802,
    status: 'completed',
    total: '88.00',
    currency: 'MAD',
    billing: {
      first_name: 'Mixed',
      last_name: 'Batch',
      phone: '+212611111802',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Mixed', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'wasender-batch-2'
    },
    payload: {
      data: {
        messages: [
          {},
          {
            key: {
              cleanedSenderPn: '212611111802',
              fromMe: false,
              id: 'feedback-batch-802'
            },
            messageBody: 'FDBK-802 smooth delivery'
          }
        ]
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.processed, 1);
  assert.equal(result.body.ignored, 1);
  assert.ok(wooNoteCalls.some((note) => note.orderId === '802' && /\[text\]/.test(note.note)));
});

test('text feedback token updates only feedback meta', async () => {
  const { app, listedOrders, wooOrderUpdates } = createTestContext();
  listedOrders.push({
    id: 901,
    status: 'completed',
    total: '99.00',
    currency: 'MAD',
    billing: {
      first_name: 'Text',
      last_name: 'Feedback',
      phone: '+212611111901',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Text', quantity: 1 }],
    meta_data: [
      ...buildWorkflowMeta({
        state: 'confirmed',
        confirmationSentAt: '2026-03-18T08:00:00.000Z'
      }),
      ...buildDecisionMeta({
        decision: 'confirmed',
        decisionAt: '2026-03-18T09:00:00.000Z'
      }),
      ...buildFeedbackMeta({
        state: 'waiting_for_feedback'
      })
    ]
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-text-901'
    },
    payload: {
      key: {
        cleanedSenderPn: '212611111901',
        fromMe: false,
        id: 'feedback-text-901-message'
      },
      messageBody: 'FDBK-901 great service'
    }
  });

  assert.equal(result.statusCode, 200);
  const order = listedOrders.find((item) => String(item.id) === '901');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_text'), 'FDBK-901 great service');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_reply_count'), 1);
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_whatsapp_state'), 'confirmed');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_whatsapp_decision'), 'confirmed');
  assert.ok(wooOrderUpdates.some((update) => update.orderId === '901' && !update.fields.status));
});

test('self-test feedback token matches case-insensitively and preserves plugin meta', async () => {
  const { app, listedOrders, wasenderCalls } = createTestContext();
  listedOrders.push({
    id: 911,
    status: 'completed',
    total: '109.00',
    currency: 'EUR',
    billing: {
      first_name: 'Self',
      last_name: 'Test',
      phone: '+212611111911',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Self Test', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      token: 'FDBK-TEST-20260420T094452Z-Y7ZNGL',
      testPhone: '+491729031097',
      testActive: 'yes',
      isTest: 'yes',
      testRunId: 'selftest-20260420T094452Z-y7zngl',
      requestedAt: '2026-04-20T09:44:53Z',
      sentAt: '2026-04-20T09:44:53Z'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-self-test-token-911'
    },
    payload: {
      key: {
        cleanedSenderPn: '491729031097',
        fromMe: false,
        id: 'feedback-self-test-token-911-message'
      },
      messageBody: 'fdbk-test-20260420t094452z-y7zngl looks good'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback, 1);
  assert.equal(wasenderCalls.length, 0);
  const order = listedOrders.find((item) => String(item.id) === '911');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_text'), 'fdbk-test-20260420t094452z-y7zngl looks good');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_token'), 'FDBK-TEST-20260420T094452Z-Y7ZNGL');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_test_phone'), '+491729031097');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_test_run_id'), 'selftest-20260420T094452Z-y7zngl');
});

test('cancelled self-test feedback token still records reply and does not trigger confirmation flow', async () => {
  const { app, listedOrders, wasenderCalls, wooNoteCalls } = createTestContext();
  listedOrders.push({
    id: 9110,
    status: 'cancelled',
    total: '0.00',
    currency: 'EUR',
    billing: {
      first_name: 'Cancelled',
      last_name: 'SelfTest',
      phone: '+212611119110',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Feedback Self Test', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      token: 'FDBK-TEST-20260420T122000Z-CANCELLED',
      testPhone: '+491729031097',
      testActive: 'yes',
      isTest: 'yes',
      testRunId: 'selftest-cancelled-9110'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-cancelled-self-test-token-9110'
    },
    payload: {
      key: {
        cleanedSenderPn: '491729031097',
        fromMe: false,
        id: 'feedback-cancelled-self-test-token-9110-message'
      },
      messageBody: 'FDBK-TEST-20260420T122000Z-CANCELLED all good'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback, 1);
  assert.equal(wasenderCalls.length, 0);
  const order = listedOrders.find((item) => String(item.id) === '9110');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_text'), 'FDBK-TEST-20260420T122000Z-CANCELLED all good');
  assert.equal(wooNoteCalls.some((note) => note.orderId === '9110' && /\[text\]/.test(note.note)), true);
});

test('unmatched self-test token stays in feedback flow and does not trigger confirmation replies', async () => {
  const { app, store, wasenderCalls } = createTestContext();
  const pendingOrder = {
    id: 912,
    status: 'pending',
    total: '110.00',
    currency: 'EUR',
    billing: {
      first_name: 'Pending',
      last_name: 'Confirm',
      phone: '+491729031097',
      state: 'Berlin'
    },
    line_items: [{ name: 'Produit Pending', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(pendingOrder),
      'x-wc-webhook-delivery-id': 'delivery-self-test-unmatched-912'
    },
    payload: pendingOrder
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-self-test-unmatched-912'
    },
    payload: {
      key: {
        cleanedSenderPn: '491729031097',
        fromMe: false,
        id: 'feedback-self-test-unmatched-912-message'
      },
      messageBody: 'FDBK-TEST-UNKNOWN'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ignored, 1);
  assert.equal(wasenderCalls.length, 1);
  assert.equal(store.read().events.at(-1).status, 'feedback_unmatched');
  assert.equal(store.getOrder('912').confirmationState, 'pending_confirmation');
});

test('image feedback with caption stores caption media url and mime type', async () => {
  const { app, listedOrders, wooNoteCalls } = createTestContext();
  listedOrders.push({
    id: 902,
    status: 'completed',
    total: '99.00',
    currency: 'MAD',
    billing: {
      first_name: 'Image',
      last_name: 'Caption',
      phone: '+212611111902',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Image', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback'
    })
  });

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-image-902'
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '212611111902',
            fromMe: false,
            id: 'feedback-image-902-message'
          },
          message: {
            imageMessage: {
              caption: 'FDBK-902 packed well',
              mimetype: 'image/png',
              url: 'https://cdn.example.com/902.png'
            }
          }
        }
      }
    }
  });

  const order = listedOrders.find((item) => String(item.id) === '902');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_caption'), 'FDBK-902 packed well');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_media_url'), 'https://cdn.example.com/902.png');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_mime_type'), 'image/png');
  assert.ok(wooNoteCalls.some((note) => note.orderId === '902' && /\[image\]/.test(note.note)));
});

test('image feedback without caption falls back by unique waiting-feedback phone', async () => {
  const { app, listedOrders } = createTestContext();
  listedOrders.push({
    id: 903,
    status: 'completed',
    total: '99.00',
    currency: 'MAD',
    billing: {
      first_name: 'Image',
      last_name: 'Fallback',
      phone: '+212611111903',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Image Fallback', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-image-903'
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '212611111903',
            fromMe: false,
            id: 'feedback-image-903-message'
          },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              url: 'https://cdn.example.com/903.jpg'
            }
          }
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  const order = listedOrders.find((item) => String(item.id) === '903');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_caption'), '');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_media_url'), 'https://cdn.example.com/903.jpg');
});

test('media-only self-test reply matches by active test phone', async () => {
  const { app, listedOrders, wasenderCalls } = createTestContext();
  listedOrders.push({
    id: 9031,
    status: 'completed',
    total: '101.00',
    currency: 'EUR',
    billing: {
      first_name: 'Media',
      last_name: 'SelfTest',
      phone: '+212611119031',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Media Self Test', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      token: 'FDBK-TEST-9031',
      testPhone: '+491729031097',
      testActive: 'yes',
      testRunId: 'selftest-9031'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-self-test-phone-9031'
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '491729031097',
            fromMe: false,
            id: 'feedback-self-test-phone-9031-message'
          },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              url: 'https://cdn.example.com/9031.jpg'
            }
          }
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback, 1);
  assert.equal(wasenderCalls.length, 0);
  const order = listedOrders.find((item) => String(item.id) === '9031');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_media_url'), 'https://cdn.example.com/9031.jpg');
});

test('cancelled self-test phone fallback records reply without clarification message', async () => {
  const { app, listedOrders, wasenderCalls } = createTestContext();
  listedOrders.push({
    id: 9032,
    status: 'cancelled',
    total: '0.00',
    currency: 'EUR',
    billing: {
      first_name: 'Cancelled',
      last_name: 'PhoneFallback',
      phone: '+212611119032',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Feedback Phone Fallback', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      token: 'FDBK-TEST-9032',
      testPhone: '+491729031097',
      testActive: 'yes',
      testRunId: 'selftest-9032'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-cancelled-self-test-phone-9032'
    },
    payload: {
      key: {
        cleanedSenderPn: '491729031097',
        fromMe: false,
        id: 'feedback-cancelled-self-test-phone-9032-message'
      },
      messageBody: 'not 1 or 2'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback, 1);
  assert.equal(wasenderCalls.length, 0);
  const order = listedOrders.find((item) => String(item.id) === '9032');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_text'), 'not 1 or 2');
});

for (const scenario of [
  {
    name: 'audio',
    orderId: 904,
    phone: '+212611111904',
    message: {
      audioMessage: {
        mimetype: 'audio/ogg',
        url: 'https://cdn.example.com/904.ogg'
      }
    }
  },
  {
    name: 'video',
    orderId: 905,
    phone: '+212611111905',
    message: {
      videoMessage: {
        caption: 'FDBK-905 video proof',
        mimetype: 'video/mp4',
        url: 'https://cdn.example.com/905.mp4'
      }
    }
  },
  {
    name: 'document',
    orderId: 906,
    phone: '+212611111906',
    message: {
      documentMessage: {
        caption: 'FDBK-906 invoice attached',
        mimetype: 'application/pdf',
        fileName: 'feedback-906.pdf'
      }
    }
  },
  {
    name: 'sticker',
    orderId: 907,
    phone: '+212611111907',
    message: {
      stickerMessage: {
        mimetype: 'image/webp',
        url: 'https://cdn.example.com/907.webp'
      }
    }
  }
]) {
  test(`${scenario.name} feedback with explicit token updates feedback meta`, async () => {
    const { app, listedOrders } = createTestContext();
    listedOrders.push({
      id: scenario.orderId,
      status: 'completed',
      total: '77.00',
      currency: 'MAD',
      billing: {
        first_name: 'Media',
        last_name: scenario.name,
        phone: scenario.phone,
        state: 'Casablanca'
      },
      line_items: [{ name: `Produit ${scenario.name}`, quantity: 1 }],
      meta_data: buildFeedbackMeta({
        state: 'waiting_for_feedback'
      })
    });

    const message =
      {
        key: {
          cleanedSenderPn: `212${scenario.phone.slice(1)}`,
          fromMe: false,
          id: `feedback-${scenario.name}-${scenario.orderId}`
        },
        messageBody: `FDBK-${scenario.orderId}`,
        message: scenario.message
      };

    await dispatch(app, {
      method: 'POST',
      url: '/webhooks/wasender',
      headers: {
        'x-wasender-signature': signWasenderPlain(),
        'x-event-id': `feedback-${scenario.name}-${scenario.orderId}`
      },
      payload: {
        data: {
          messages: message
        }
      }
    });

    const order = listedOrders.find((item) => String(item.id) === String(scenario.orderId));
    assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_state'), 'reply_received');
    assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_last_kind'), scenario.name);
  });
}

test('random inbound image without feedback match is ignored and not routed to confirmation', async () => {
  const { app, store, wasenderCalls } = createTestContext();
  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'random-image-unmatched'
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '212611111999',
            fromMe: false
          },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              url: 'https://cdn.example.com/random.jpg'
            }
          }
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ignored, 1);
  assert.equal(wasenderCalls.length, 0);
  assert.equal(store.read().events.at(-1).status, 'unmatched_inbound');
});

for (const scenario of [
  {
    name: 'video',
    message: {
      videoMessage: {
        mimetype: 'video/mp4',
        url: 'https://cdn.example.com/unmatched.mp4'
      }
    }
  },
  {
    name: 'document',
    message: {
      documentMessage: {
        mimetype: 'application/pdf',
        fileName: 'unmatched.pdf'
      }
    }
  },
  {
    name: 'sticker',
    message: {
      stickerMessage: {
        mimetype: 'image/webp',
        url: 'https://cdn.example.com/unmatched.webp'
      }
    }
  }
]) {
  test(`random inbound ${scenario.name} without confirmation candidate is ignored`, async () => {
    const { app, store } = createTestContext();
    const result = await dispatch(app, {
      method: 'POST',
      url: '/webhooks/wasender',
      headers: {
        'x-wasender-signature': signWasenderPlain(),
        'x-event-id': `unmatched-${scenario.name}`
      },
      payload: {
        data: {
          messages: {
            key: {
              cleanedSenderPn: '212611112000',
              fromMe: false
            },
            message: scenario.message
          }
        }
      }
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ignored, 1);
    assert.equal(store.read().events.at(-1).status, 'unmatched_inbound');
  });
}

test('repeated provider message id does not increment feedback reply count twice', async () => {
  const { app, listedOrders, wooNoteCalls } = createTestContext();
  listedOrders.push({
    id: 908,
    status: 'completed',
    total: '66.00',
    currency: 'MAD',
    billing: {
      first_name: 'Repeat',
      last_name: 'Feedback',
      phone: '+212611111908',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Repeat', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback'
    })
  });

  const payload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212611111908',
          fromMe: false,
          id: 'feedback-repeat-908'
        },
        messageBody: 'FDBK-908 all good'
      }
    }
  };

  const firstResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-repeat-908-a'
    },
    payload
  });
  const secondResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-repeat-908-b'
    },
    payload
  });

  const order = listedOrders.find((item) => String(item.id) === '908');
  assert.equal(firstResult.statusCode, 200);
  assert.equal(secondResult.statusCode, 200);
  assert.equal(workflowMetaValue(order.meta_data, 'rhymat_feedback_reply_count'), 1);
  assert.equal(secondResult.body.duplicates, 1);
  assert.equal(wooNoteCalls.filter((note) => note.orderId === '908').length, 1);
});

test('ambiguous waiting-feedback phone match is skipped safely', async () => {
  const { app, store, listedOrders, wooNoteCalls } = createTestContext();
  listedOrders.push(
    {
      id: 909,
      status: 'completed',
      total: '66.00',
      currency: 'MAD',
      billing: {
        first_name: 'Ambiguous',
        last_name: 'One',
        phone: '+212611111909',
        state: 'Casablanca'
      },
      line_items: [{ name: 'Produit Ambiguous 1', quantity: 1 }],
      meta_data: buildFeedbackMeta({
        state: 'waiting_for_feedback'
      })
    },
    {
      id: 910,
      status: 'completed',
      total: '67.00',
      currency: 'MAD',
      billing: {
        first_name: 'Ambiguous',
        last_name: 'Two',
        phone: '+212611111909',
        state: 'Casablanca'
      },
      line_items: [{ name: 'Produit Ambiguous 2', quantity: 1 }],
      meta_data: buildFeedbackMeta({
        state: 'waiting_for_feedback'
      })
    }
  );

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-ambiguous-909'
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '212611111909',
            fromMe: false
          },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              url: 'https://cdn.example.com/ambiguous.jpg'
            }
          }
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ignored, 1);
  assert.equal(store.read().events.at(-1).status, 'feedback_match_ambiguous');
  assert.equal(wooNoteCalls.length, 0);
});

test('ambiguous self-test phone match is skipped without falling into confirmation', async () => {
  const { app, store, listedOrders, wasenderCalls, wooNoteCalls } = createTestContext();
  listedOrders.push(
    {
      id: 9111,
      status: 'completed',
      total: '66.00',
      currency: 'EUR',
      billing: {
        first_name: 'Self',
        last_name: 'One',
        phone: '+212611119111',
        state: 'Casablanca'
      },
      line_items: [{ name: 'Produit Self 1', quantity: 1 }],
      meta_data: buildFeedbackMeta({
        state: 'waiting_for_feedback',
        testPhone: '+491729031097',
        testActive: 'yes',
        testRunId: 'selftest-9111'
      })
    },
    {
      id: 9112,
      status: 'completed',
      total: '67.00',
      currency: 'EUR',
      billing: {
        first_name: 'Self',
        last_name: 'Two',
        phone: '+212611119112',
        state: 'Casablanca'
      },
      line_items: [{ name: 'Produit Self 2', quantity: 1 }],
      meta_data: buildFeedbackMeta({
        state: 'waiting_for_feedback',
        testPhone: '+491729031097',
        testActive: 'yes',
        testRunId: 'selftest-9112'
      })
    }
  );

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-self-test-ambiguous-9111'
    },
    payload: {
      data: {
        messages: {
          key: {
            cleanedSenderPn: '491729031097',
            fromMe: false,
            id: 'feedback-self-test-ambiguous-9111-message'
          },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              url: 'https://cdn.example.com/9111.jpg'
            }
          }
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ignored, 1);
  assert.equal(store.read().events.at(-1).status, 'feedback_match_ambiguous');
  assert.equal(wooNoteCalls.length, 0);
  assert.equal(wasenderCalls.length, 0);
});

test('self-test phone feedback takes priority over confirmation replies for the same sender', async () => {
  const { app, store, listedOrders, wasenderCalls } = createTestContext();
  const confirmationOrder = {
    id: 913,
    status: 'pending',
    total: '110.00',
    currency: 'EUR',
    billing: {
      first_name: 'Confirm',
      last_name: 'First',
      phone: '+491729031097',
      state: 'Berlin'
    },
    line_items: [{ name: 'Produit Confirm Priority', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(confirmationOrder),
      'x-wc-webhook-delivery-id': 'delivery-self-test-priority-913'
    },
    payload: confirmationOrder
  });

  listedOrders.push({
    id: 914,
    status: 'completed',
    total: '120.00',
    currency: 'EUR',
    billing: {
      first_name: 'Feedback',
      last_name: 'Priority',
      phone: '+212611119140',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Feedback Priority', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      testPhone: '+491729031097',
      testActive: 'yes',
      testRunId: 'selftest-914'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-self-test-priority-913'
    },
    payload: {
      key: {
        cleanedSenderPn: '491729031097',
        fromMe: false,
        id: 'feedback-self-test-priority-913-message'
      },
      messageBody: '1'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback, 1);
  assert.equal(result.body.confirmation, 0);
  assert.equal(wasenderCalls.length, 1);
  assert.equal(store.getOrder('913').confirmationState, 'pending_confirmation');
  assert.equal(workflowMetaValue(listedOrders.find((item) => String(item.id) === '914').meta_data, 'rhymat_feedback_state'), 'reply_received');
});

test('cancelled self-test feedback still takes priority over real pending confirmation orders', async () => {
  const { app, store, listedOrders, wasenderCalls } = createTestContext();
  const confirmationOrder = {
    id: 915,
    status: 'pending',
    total: '110.00',
    currency: 'EUR',
    billing: {
      first_name: 'Confirm',
      last_name: 'Second',
      phone: '+491729031097',
      state: 'Berlin'
    },
    line_items: [{ name: 'Produit Confirm Cancelled Priority', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(confirmationOrder),
      'x-wc-webhook-delivery-id': 'delivery-self-test-priority-915'
    },
    payload: confirmationOrder
  });

  listedOrders.push({
    id: 916,
    status: 'cancelled',
    total: '0.00',
    currency: 'EUR',
    billing: {
      first_name: 'Feedback',
      last_name: 'CancelledPriority',
      phone: '+212611119160',
      state: 'Casablanca'
    },
    line_items: [{ name: 'Produit Feedback Cancelled Priority', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      testPhone: '+491729031097',
      testActive: 'yes',
      testRunId: 'selftest-916',
      token: 'FDBK-TEST-916'
    })
  });

  const result = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain(),
      'x-event-id': 'feedback-cancelled-self-test-priority-915'
    },
    payload: {
      key: {
        cleanedSenderPn: '491729031097',
        fromMe: false,
        id: 'feedback-cancelled-self-test-priority-915-message'
      },
      messageBody: 'not 1 or 2'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback, 1);
  assert.equal(result.body.confirmation, 0);
  assert.equal(wasenderCalls.length, 1);
  assert.equal(store.getOrder('915').confirmationState, 'pending_confirmation');
  assert.equal(workflowMetaValue(listedOrders.find((item) => String(item.id) === '916').meta_data, 'rhymat_feedback_state'), 'reply_received');
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
        phone: '+212612345678',
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
        phone: '+212612345679',
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

test('backfill skips feedback self-test orders without sending confirmation', async () => {
  const { confirmationService, wasenderCalls, listedOrders, wooNoteCalls } = createTestContext();
  listedOrders.push({
    id: 203,
    status: 'processing',
    total: '0.00',
    currency: 'EUR',
    billing: {
      first_name: 'Backfill',
      last_name: 'SelfTest',
      phone: '+491729031097',
      state: 'Berlin',
      address_1: '3 Rue Backfill'
    },
    line_items: [{ name: 'Feedback Self Test', quantity: 1 }],
    meta_data: buildFeedbackMeta({
      state: 'waiting_for_feedback',
      token: 'FDBK-TEST-20260420T102451Z-BTIAIB',
      testPhone: '+491729031097',
      testActive: 'yes',
      isTest: 'yes',
      testRunId: 'selftest-20260420T102451Z-btiaib',
      requestedAt: '2026-04-20T10:25:23Z',
      sentAt: '2026-04-20T10:25:23Z'
    })
  });

  const summary = await confirmationService.runOrderFollowups({
    backfillOnly: true,
    now: new Date('2026-04-20T12:00:00.000Z')
  });

  assert.equal(summary.backfilled, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.errors, 0);
  assert.equal(wasenderCalls.length, 0);
  assert.equal(wooNoteCalls.length, 0);
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
      phone: '+212611111111',
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
      phone: '+212622222222',
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
      phone: '+212633333333',
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
      phone: '+212644444444',
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

test('valid reply keeps decision final and retries Woo sync silently after failure', async () => {
  const { app, store, wasenderCalls, listedOrders, wooOrderUpdates, confirmationService } = createTestContext();
  const orderPayload = {
    id: 402,
    status: 'pending',
    total: '260.00',
    currency: 'MAD',
    billing: {
      first_name: 'Retry',
      last_name: 'Sync',
      phone: '+212644444445',
      state: 'Casablanca',
      address_1: '4 Rue Retry'
    },
    line_items: [{ name: 'Produit Retry', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-402'
    },
    payload: orderPayload
  });

  let failOnce = true;
  const originalUpdateOrder = confirmationService.wooClient.updateOrder.bind(confirmationService.wooClient);
  confirmationService.wooClient.updateOrder = async (orderId, fields) => {
    if (failOnce && fields.status) {
      failOnce = false;
      throw new Error('temporary woo failure');
    }
    return originalUpdateOrder(orderId, fields);
  };

  const replyPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212644444445',
          fromMe: false
        },
        messageBody: '1'
      }
    }
  };

  const replyResult = await dispatch(app, {
    method: 'POST',
    url: '/webhooks/wasender',
    headers: {
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  assert.equal(replyResult.statusCode, 200);
  assert.equal(store.getOrder('402').confirmationState, 'confirmed');
  assert.equal(store.getOrder('402').wooSyncStatus, 'pending_retry');
  assert.equal(store.getOrder('402').customerReplySent, 'yes');
  assert.equal(wasenderCalls.length, 4);

  listedOrders.push({
    ...store.getOrder('402').rawOrder,
    id: 402,
    status: 'processing'
  });

  const summary = await confirmationService.runOrderFollowups({ now: new Date('2026-03-18T10:00:00.000Z') });

  assert.equal(summary.errors, 0);
  const retryStatusUpdate = [...wooOrderUpdates].reverse().find((u) => u.fields.status);
  assert.equal(retryStatusUpdate?.orderId, '402');
  assert.equal(retryStatusUpdate?.fields.status, 'on-hold');
  assert.equal(store.getOrder('402').wooSyncStatus, 'synced');
  assert.equal(store.getOrder('402').confirmationState, 'confirmed');
  assert.equal(wasenderCalls.length, 4);
});

test('internal notification failure does not block final customer flow', async () => {
  const { app, store, wasenderCalls, confirmationService } = createTestContext();
  let internalFailureTriggered = false;
  confirmationService.wasenderClient.sendMessage = async (payload) => {
    if (payload.to === '+491729031097' && !internalFailureTriggered) {
      internalFailureTriggered = true;
      throw new Error('internal notify failed');
    }
    wasenderCalls.push(payload);
    return { id: `msg-${wasenderCalls.length}` };
  };

  const orderPayload = {
    id: 601,
    status: 'pending',
    total: '180.00',
    currency: 'MAD',
    billing: {
      first_name: 'Notif',
      last_name: 'Fail',
      phone: '+212650000003',
      state: 'Casablanca',
      address_1: '6 Rue Notify'
    },
    line_items: [{ name: 'Produit Notify', quantity: 1 }]
  };

  await dispatch(app, {
    method: 'POST',
    url: '/webhooks/woocommerce',
    headers: {
      'x-wc-webhook-signature': signWoo(orderPayload),
      'x-wc-webhook-delivery-id': 'delivery-601'
    },
    payload: orderPayload
  });

  const replyPayload = {
    data: {
      messages: {
        key: {
          cleanedSenderPn: '212650000003',
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
      'x-wasender-signature': signWasenderPlain()
    },
    payload: replyPayload
  });

  assert.equal(result.statusCode, 200);
  assert.equal(store.getOrder('601').confirmationState, 'confirmed');
  assert.equal(store.getOrder('601').customerReplySent, 'yes');
  assert.equal(store.getOrder('601').internalNotifiedConfirmed, 'yes');
  assert.equal(wasenderCalls[1].message, 'Chokran, la commande dyalk t confirmat. Ghadi ytwasl m3ak livreur mli twsl la commande lmdintk.');
});

test('manual cancelled status stops confirmed order workflow instead of restoring on-hold', async () => {
  const { confirmationService, store, listedOrders, wooStatusCalls } = createTestContext();
  listedOrders.push({
    id: 501,
    status: 'cancelled',
    total: '300.00',
    currency: 'MAD',
    billing: {
      first_name: 'Manual',
      last_name: 'Cancel',
      phone: '+212650000001',
      state: 'Casablanca',
      address_1: '1 Rue Manual'
    },
    line_items: [{ name: 'Produit Manual', quantity: 1 }],
    meta_data: [
      { key: 'rhymat_whatsapp_decision', value: 'confirmed' },
      { key: 'rhymat_whatsapp_decision_at', value: '2026-03-22T08:00:00.000Z' },
      { key: 'rhymat_whatsapp_woo_sync_status', value: 'synced' },
      { key: 'rhymat_whatsapp_customer_reply_sent', value: 'yes' }
    ]
  });

  store.upsertOrder({
    orderId: '501',
    phone: '+212650000001',
    confirmationState: 'confirmed',
    decision: 'confirmed',
    decisionAt: '2026-03-22T08:00:00.000Z',
    wooSyncStatus: 'synced',
    rawOrder: listedOrders[0]
  });

  const summary = await confirmationService.runOrderFollowups({ now: new Date('2026-03-22T10:00:00.000Z') });

  assert.equal(summary.errors, 0);
  assert.equal(wooStatusCalls.length, 0);
  assert.equal(store.getOrder('501').confirmationState, 'manual');
  assert.equal(store.getOrder('501').wooSyncStatus, 'manual');
  assert.equal(store.getOrder('501').manualOverride, 'yes');
  assert.equal(store.getOrder('501').manualOverrideStatus, 'cancelled');
});

test('manual non-processing status stops pending reminder workflow', async () => {
  const { confirmationService, store, listedOrders, wasenderCalls, wooStatusCalls } = createTestContext();
  listedOrders.push({
    id: 502,
    status: 'completed',
    total: '310.00',
    currency: 'MAD',
    billing: {
      first_name: 'Manual',
      last_name: 'Pending',
      phone: '+212650000002',
      state: 'Rabat',
      address_1: '2 Rue Manual'
    },
    line_items: [{ name: 'Produit Pending', quantity: 1 }],
    meta_data: [
      { key: 'rhymat_whatsapp_state', value: 'pending' },
      { key: 'rhymat_whatsapp_confirmation_sent_at', value: '2026-03-21T08:00:00.000Z' },
      { key: 'rhymat_whatsapp_reminder_count', value: 0 }
    ]
  });

  store.upsertOrder({
    orderId: '502',
    phone: '+212650000002',
    confirmationState: 'pending_confirmation',
    rawOrder: listedOrders[0]
  });

  const summary = await confirmationService.runOrderFollowups({ now: new Date('2026-03-22T10:00:00.000Z') });

  assert.equal(summary.errors, 0);
  assert.equal(wooStatusCalls.length, 0);
  assert.equal(wasenderCalls.length, 0);
  assert.equal(store.getOrder('502').confirmationState, 'manual');
  assert.equal(store.getOrder('502').wooSyncStatus, 'manual');
  assert.equal(store.getOrder('502').manualOverrideStatus, 'completed');
});

test('normalizePhone only accepts E.164-style international inputs', () => {
  assert.equal(normalizePhone('+212 6 12 34 56 78'), '+212612345678');
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhone('00212612345678'), '+212612345678');
  assert.equal(normalizePhone('0033612345678'), '+33612345678');
  assert.equal(normalizePhone('123'), '');
  assert.equal(normalizePhone('06 12 34 56 78'), '');
  assert.equal(normalizePhone('212612345678'), '+212612345678');
});

test('validatePhone distinguishes missing, invalid, and valid numbers', () => {
  assert.deepEqual(validatePhone(''), {
    normalized: '',
    isValid: false,
    reason: 'missing_phone'
  });
  assert.deepEqual(validatePhone('0521234567'), {
    normalized: '',
    isValid: false,
    reason: 'invalid_phone'
  });
  assert.deepEqual(validatePhone('0033612345678'), {
    normalized: '+33612345678',
    isValid: true,
    reason: ''
  });
});

// --- Dashboard API endpoint tests ---

test('GET /api/orders returns live workflow stages and merged fields', async () => {
  const { app, listedOrders, store } = createTestContext();
  listedOrders.push(
    {
      id: 1,
      status: 'processing',
      total: '100.00',
      currency: 'MAD',
      billing: {
        first_name: 'Ali',
        last_name: 'One',
        phone: '+212611111111',
        state: 'Casablanca',
        address_1: '1 Rue Atlas'
      },
      line_items: [{ name: 'Produit A', quantity: 1 }],
      meta_data: buildWorkflowMeta({
        state: 'pending',
        confirmationSentAt: '2026-03-20T10:00:00.000Z',
        reminderCount: 0
      })
    },
    {
      id: 2,
      status: 'processing',
      total: '110.00',
      currency: 'MAD',
      billing: {
        first_name: 'Sara',
        last_name: 'Two',
        phone: '+212622222222',
        state: 'Rabat',
        address_1: '2 Rue Atlas'
      },
      line_items: [{ name: 'Produit B', quantity: 1 }],
      meta_data: buildWorkflowMeta({
        state: 'pending',
        confirmationSentAt: '2026-03-19T10:00:00.000Z',
        reminderCount: 1,
        lastReminderAt: '2026-03-20T10:00:00.000Z'
      })
    },
    {
      id: 3,
      status: 'processing',
      total: '120.00',
      currency: 'MAD',
      billing: {
        first_name: 'Yassine',
        last_name: 'Three',
        phone: '+212633333333',
        state: 'Marrakech',
        address_1: '3 Rue Atlas'
      },
      line_items: [{ name: 'Produit C', quantity: 1 }],
      meta_data: buildWorkflowMeta({
        state: 'pending',
        confirmationSentAt: '2026-03-18T10:00:00.000Z',
        reminderCount: 2,
        lastReminderAt: '2026-03-20T10:00:00.000Z'
      })
    },
    {
      id: 4,
      status: 'on-hold',
      total: '130.00',
      currency: 'MAD',
      billing: {
        first_name: 'Mina',
        last_name: 'Four',
        phone: '+212644444444',
        state: 'Casablanca',
        address_1: '4 Rue Atlas'
      },
      line_items: [{ name: 'Produit D', quantity: 1 }],
      meta_data: [
        ...buildWorkflowMeta({
          state: 'confirmed',
          confirmationSentAt: '2026-03-17T10:00:00.000Z',
          reminderCount: 1,
          lastReminderAt: '2026-03-18T10:00:00.000Z'
        }),
        ...buildDecisionMeta({
          decision: 'confirmed',
          decisionAt: '2026-03-18T12:00:00.000Z',
          wooSyncStatus: 'synced',
          wooSyncAttempts: 2,
          customerReplySent: 'yes'
        })
      ]
    },
    {
      id: 5,
      status: 'completed',
      total: '140.00',
      currency: 'MAD',
      billing: {
        first_name: 'Omar',
        last_name: 'Five',
        phone: '+212655555555',
        state: 'Rabat',
        address_1: '5 Rue Atlas'
      },
      line_items: [{ name: 'Produit E', quantity: 1 }],
      meta_data: [
        ...buildWorkflowMeta({
          state: 'manual',
          confirmationSentAt: '2026-03-16T10:00:00.000Z',
          reminderCount: 1
        }),
        ...buildDecisionMeta({
          wooSyncStatus: 'manual',
          manualOverride: 'yes',
          manualOverrideAt: '2026-03-17T09:00:00.000Z',
          manualOverrideStatus: 'completed'
        })
      ]
    }
  );

  store.upsertOrder({
    orderId: '2',
    confirmationState: 'cancelled',
    phone: '+212622222222',
    reminderCount: 99,
    invalidReplyCount: 2,
    manualFollowupRequired: true,
    lastError: 'stale-local-state'
  });

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/orders',
    headers: { 'x-task-secret': 'task-secret' }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.orders.length, 5);

  const byId = Object.fromEntries(result.body.orders.map((order) => [order.orderId, order]));
  assert.equal(byId['1'].status, 'confirmation_sent');
  assert.equal(byId['1'].workflowState, 'pending');
  assert.equal(byId['1'].reminderCount, 0);

  assert.equal(byId['2'].status, 'first_reminder_sent');
  assert.equal(byId['2'].reminderCount, 1);
  assert.equal(byId['2'].manualFollowupRequired, true);
  assert.equal(byId['2'].invalidReplyCount, 2);
  assert.equal(byId['2'].lastError, 'stale-local-state');

  assert.equal(byId['3'].status, 'second_reminder_sent');
  assert.equal(byId['3'].lastReminderAt, '2026-03-20T10:00:00.000Z');

  assert.equal(byId['4'].status, 'confirmed');
  assert.equal(byId['4'].decision, 'confirmed');
  assert.equal(byId['4'].wooSyncStatus, 'synced');
  assert.equal(byId['4'].customerReplySent, 'yes');

  assert.equal(byId['5'].status, 'manual');
  assert.equal(byId['5'].manualOverride, 'yes');
  assert.equal(byId['5'].manualOverrideStatus, 'completed');

  assert.equal(byId['1'].rawOrder, undefined);
});

test('GET /api/orders includes local-only send failure states', async () => {
  const { app, store } = createTestContext();
  store.upsertOrder({
    orderId: '901',
    confirmationState: 'send_failed',
    phone: '+212600000901',
    customerName: 'Failed Send',
    lastError: 'gateway error'
  });
  store.upsertOrder({
    orderId: '902',
    confirmationState: 'failed_missing_phone',
    customerName: 'No Phone',
    lastError: 'Missing or invalid phone number'
  });

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/orders',
    headers: { 'x-task-secret': 'task-secret' }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(
    result.body.orders.map((order) => order.status).sort(),
    ['failed_missing_phone', 'send_failed']
  );
  assert.equal(result.body.orders.find((order) => order.orderId === '901').lastError, 'gateway error');
});

test('GET /api/orders?status=first_reminder_sent filters by exact stage', async () => {
  const { app, listedOrders } = createTestContext();
  listedOrders.push(
    {
      id: 1,
      status: 'processing',
      total: '100.00',
      currency: 'MAD',
      billing: {
        first_name: 'Ali',
        last_name: 'One',
        phone: '+212611111111',
        state: 'Casablanca',
        address_1: '1 Rue Atlas'
      },
      line_items: [{ name: 'Produit A', quantity: 1 }],
      meta_data: buildWorkflowMeta({
        state: 'pending',
        confirmationSentAt: '2026-03-20T10:00:00.000Z',
        reminderCount: 1
      })
    },
    {
      id: 2,
      status: 'on-hold',
      total: '110.00',
      currency: 'MAD',
      billing: {
        first_name: 'Sara',
        last_name: 'Two',
        phone: '+212622222222',
        state: 'Rabat',
        address_1: '2 Rue Atlas'
      },
      line_items: [{ name: 'Produit B', quantity: 1 }],
      meta_data: [
        ...buildWorkflowMeta({
          state: 'confirmed',
          confirmationSentAt: '2026-03-19T10:00:00.000Z',
          reminderCount: 1
        }),
        ...buildDecisionMeta({
          decision: 'confirmed',
          decisionAt: '2026-03-20T10:00:00.000Z',
          wooSyncStatus: 'synced'
        })
      ]
    }
  );

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/orders?status=first_reminder_sent',
    headers: { 'x-task-secret': 'task-secret' }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.orders.length, 1);
  assert.equal(result.body.orders[0].orderId, '1');
  assert.equal(result.body.orders[0].status, 'first_reminder_sent');
});

test('GET /api/orders/summary returns counts by exact stage', async () => {
  const { app, listedOrders, store } = createTestContext();
  listedOrders.push(
    {
      id: 1,
      status: 'processing',
      total: '100.00',
      currency: 'MAD',
      billing: {
        first_name: 'Ali',
        last_name: 'One',
        phone: '+212611111111',
        state: 'Casablanca',
        address_1: '1 Rue Atlas'
      },
      line_items: [{ name: 'Produit A', quantity: 1 }],
      meta_data: buildWorkflowMeta({
        state: 'pending',
        confirmationSentAt: '2026-03-20T10:00:00.000Z',
        reminderCount: 0
      })
    },
    {
      id: 2,
      status: 'processing',
      total: '110.00',
      currency: 'MAD',
      billing: {
        first_name: 'Sara',
        last_name: 'Two',
        phone: '+212622222222',
        state: 'Rabat',
        address_1: '2 Rue Atlas'
      },
      line_items: [{ name: 'Produit B', quantity: 1 }],
      meta_data: buildWorkflowMeta({
        state: 'pending',
        confirmationSentAt: '2026-03-19T10:00:00.000Z',
        reminderCount: 1
      })
    },
    {
      id: 3,
      status: 'cancelled',
      total: '120.00',
      currency: 'MAD',
      billing: {
        first_name: 'Yassine',
        last_name: 'Three',
        phone: '+212633333333',
        state: 'Marrakech',
        address_1: '3 Rue Atlas'
      },
      line_items: [{ name: 'Produit C', quantity: 1 }],
      meta_data: [
        ...buildWorkflowMeta({
          state: 'cancelled',
          confirmationSentAt: '2026-03-18T10:00:00.000Z',
          reminderCount: 2,
          cancelledAt: '2026-03-21T10:00:00.000Z'
        }),
        ...buildDecisionMeta({
          decision: 'cancelled',
          decisionAt: '2026-03-21T10:00:00.000Z',
          wooSyncStatus: 'synced'
        })
      ]
    }
  );
  store.upsertOrder({
    orderId: '901',
    confirmationState: 'send_failed',
    phone: '+212600000901'
  });

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/orders/summary',
    headers: { 'x-task-secret': 'task-secret' }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.total, 4);
  assert.deepEqual(result.body.byStage, {
    confirmation_sent: 1,
    first_reminder_sent: 1,
    cancelled: 1,
    send_failed: 1
  });
});

test('GET /api/orders/:orderId/messages returns messages for an order', async () => {
  const { app, store } = createTestContext();
  store.appendMessage({ orderId: '101', phone: '+212600000001', source: 'outbound', kind: 'confirmation_request', text: 'Salam' });
  store.appendMessage({ orderId: '101', phone: '+212600000001', source: 'inbound', kind: 'customer_reply', text: '1' });
  store.appendMessage({ orderId: '999', phone: '+212600000009', source: 'outbound', kind: 'confirmation_request', text: 'Other' });

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/orders/101/messages',
    headers: { 'x-task-secret': 'task-secret' }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.orderId, '101');
  assert.equal(result.body.messageCount, 2);
  assert.equal(result.body.messages.length, 2);
});

test('GET /api/leads/:phone/messages returns messages for a phone number', async () => {
  const { app, store } = createTestContext();
  store.appendMessage({ orderId: '101', phone: '+212600000001', source: 'outbound', kind: 'confirmation_request', text: 'Salam' });
  store.appendMessage({ orderId: '102', phone: '+212600000001', source: 'outbound', kind: 'confirmation_request', text: 'Salam again' });
  store.appendMessage({ orderId: '103', phone: '+212600000009', source: 'outbound', kind: 'confirmation_request', text: 'Other' });

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/leads/+212600000001/messages',
    headers: { 'x-task-secret': 'task-secret' }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.phone, '+212600000001');
  assert.equal(result.body.messageCount, 2);
});

test('API endpoints return 401 without valid task secret', async () => {
  const { app } = createTestContext();

  const result = await dispatch(app, {
    method: 'GET',
    url: '/api/orders/summary',
    headers: { 'x-task-secret': 'wrong-secret' }
  });

  assert.equal(result.statusCode, 401);
});

test('API endpoints return CORS headers', async () => {
  const { app, store } = createTestContext();
  store.upsertOrder({ orderId: '1', confirmationState: 'confirmed', phone: '+212600000001' });

  const req = createMockReq({ method: 'GET', url: '/api/orders/summary', headers: { 'x-task-secret': 'task-secret' }, body: '' });
  const res = createMockRes();
  await app(req, res);

  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});
