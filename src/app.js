import { createHash } from 'node:crypto';
import { secretMatches, verifyWasenderSignature, verifyWooSignature } from './utils/signatures.js';
import { buildHealthDetails, buildReadiness } from './services/health-tracker.js';
import { warehouseQuantity } from './services/hd-product-match.js';

export const MAX_BODY_BYTES = 1024 * 1024;

export function createApp({ config, confirmationService, store, stockAlertService = null, hdStatusSyncService = null, healthTracker = null, hdClient = null, stockSyncService = null, durableState = null, logger = console, maxBodyBytes = MAX_BODY_BYTES }) {
  // The hourly task must never run twice at once (two runs could message the same customer twice).
  let followupsRunning = false;

  // Fails closed: no secret configured = 503 (nothing is accepted), a wrong secret = 401. Returns true when allowed.
  function checkTaskSecret(req, res, label, send = sendJson) {
    if (!config.tasks?.secret) {
      logger.warn(`[${label}] refused: TASK_SECRET is not set`);
      send(res, 503, { ok: false, error: 'Task secret is not configured' });
      return false;
    }
    if (!secretMatches(req.headers['x-task-secret'], config.tasks.secret)) {
      logger.warn(`[${label}] invalid task secret`);
      send(res, 401, { ok: false, error: 'Invalid task secret' });
      return false;
    }
    return true;
  }

  // The three hourly steps run one after the other, but a failure in one never skips the others.
  async function runHourlySteps() {
    let result = null;
    let followupsError = null;
    try {
      await durableState?.ensureLoaded?.();
    } catch (error) {
      logger.warn(`[task][order-followups] durable state not loaded: ${error.message}`);
    }
    try {
      result = await confirmationService.runOrderFollowups();
      logger.log(
        `[task][order-followups] completed backfilled=${result.backfilled || 0} remindersSent=${result.remindersSent || 0} autoCancelled=${result.autoCancelled || 0} ambiguous=${result.ambiguous || 0} skipped=${result.skipped || 0} errors=${result.errors || 0}`
      );
    } catch (error) {
      followupsError = error;
      logger.error(`[task][order-followups] follow-ups failed: ${error.message}`);
    }
    // The same hourly call also copies HighDelivery parcel statuses to the orders (never breaks the follow-ups).
    let hdStatus = null;
    if (hdStatusSyncService) {
      try {
        hdStatus = await hdStatusSyncService.run();
      } catch (error) {
        logger.warn(`[task][order-followups] hd status sync failed: ${error.message}`);
      }
    }
    // Stock alerts held back by the quiet hours go out now.
    if (stockAlertService) {
      try {
        await stockAlertService.processQueue();
      } catch (error) {
        logger.warn(`[task][order-followups] stock alert queue failed: ${error.message}`);
      }
    }
    return { result, hdStatus, followupsError };
  }

  // The HighDelivery items with their ids, so the desktop app links products to ids and not to names.
  async function sendHdItems(res) {
    if (!hdClient) {
      return sendCorsJson(res, 503, { ok: false, error: 'HighDelivery is not enabled' });
    }
    try {
      const rows = await hdClient.listWarehouseProducts();
      const items = rows.map((row) => ({ id: row.id, name: String(row.name ?? ''), quantity: warehouseQuantity(row) }));
      return sendCorsJson(res, 200, { ok: true, fetchedAt: new Date(hdClient.warehouseProductsAt || Date.now()).toISOString(), items });
    } catch (error) {
      logger.warn(`[api][matching] HighDelivery items unavailable: ${error.message}`);
      return sendCorsJson(res, 502, { ok: false, error: 'hd_unavailable' });
    }
  }

  // `runAt` is the health row of this follow-ups run; the stock sync result is added to it when the sync ends.
  function runStockSyncAfterResponse(runAt) {
    Promise.resolve()
      .then(() => stockSyncService.run())
      .then((stockSync) => stockSync?.summary || null, (error) => {
        logger.warn(`[task][order-followups] stock sync failed: ${error.message}`);
        return null;
      })
      .then((stockSync) => healthTracker?.attachToRun(runAt, { stockSync }))
      .catch((error) => logger.warn(`[task][order-followups] could not record the stock sync: ${error.message}`));
  }

  return async function handler(req, res) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (req.method === 'OPTIONS') {
        return sendCors(res, 204);
      }

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      // Public, for an outside monitor: booleans only (see buildReadiness). /health stays the plain liveness answer.
      if (req.method === 'GET' && pathname === '/health/ready') {
        const readiness = buildReadiness({ config, tracker: healthTracker, durableState, now: new Date() });
        return sendJson(res, readiness.ok ? 200 : 503, readiness);
      }

      if (req.method === 'GET' && pathname.startsWith('/api/')) {
        if (!checkTaskSecret(req, res, 'api', sendCorsJson)) {
          return undefined;
        }

        if (pathname === '/api/health/details') {
          if (!healthTracker) {
            return sendCorsJson(res, 503, { ok: false, error: 'Health details are not enabled' });
          }
          return sendCorsJson(res, 200, { ok: true, ...buildHealthDetails({ store, tracker: healthTracker, config, stockSyncService }) });
        }

        if (pathname === '/api/matching/hd-items') {
          return sendHdItems(res);
        }

        if (pathname === '/api/stock-sync/status') {
          if (!stockSyncService) {
            return sendCorsJson(res, 503, { ok: false, error: 'Stock sync is not enabled' });
          }
          return sendCorsJson(res, 200, { ok: true, ...(await stockSyncService.status()) });
        }

        if (pathname === '/api/orders/summary') {
          const summary = await confirmationService.getOrdersSummaryForApi();
          return sendCorsJson(res, 200, { ok: true, ...summary });
        }

        if (pathname === '/api/orders') {
          const status = parsedUrl.searchParams.get('status') || undefined;
          const orders = await confirmationService.listOrdersForApi({ status });
          return sendCorsJson(res, 200, { ok: true, orders });
        }

        const orderMessagesMatch = pathname.match(/^\/api\/orders\/([^/]+)\/messages$/);
        if (orderMessagesMatch) {
          const orderId = decodeURIComponent(orderMessagesMatch[1]);
          const messages = store.getMessagesByOrder(orderId);
          return sendCorsJson(res, 200, { ok: true, orderId, messageCount: messages.length, messages });
        }

        const leadMessagesMatch = pathname.match(/^\/api\/leads\/([^/]+)\/messages$/);
        if (leadMessagesMatch) {
          const phone = decodeURIComponent(leadMessagesMatch[1]);
          const messages = store.getMessagesByPhone(phone);
          return sendCorsJson(res, 200, { ok: true, phone, messageCount: messages.length, messages });
        }

        if (pathname === '/api/contacts/opted-out') {
          const contacts = store.listOptedOutContacts();
          const durable = durableState?.status?.() || null;
          return sendCorsJson(res, 200, { ok: true, contacts, note: durable?.loaded ? 'woocommerce_durable' : 'local_cache_only' });
        }

        return sendCorsJson(res, 404, { ok: false, error: 'Not found' });
      }

      if (req.method === 'GET' && pathname === '/tasks/stock-alerts/status') {
        if (!checkTaskSecret(req, res, 'task][stock-alerts')) {
          return undefined;
        }
        if (!stockAlertService) {
          return sendJson(res, 503, { ok: false, error: 'Stock alerts are not enabled' });
        }
        const ids = String(parsedUrl.searchParams.get('ids') || '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
          .slice(0, 200);
        return sendJson(res, 200, { ok: true, statuses: stockAlertService.statuses(ids) });
      }

      if (req.method !== 'POST') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }

      const declaredLength = Number(req.headers?.['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        return refuseTooLarge(req, res, logger);
      }
      let rawBody;
      try {
        rawBody = await readBody(req, maxBodyBytes);
      } catch (error) {
        if (error?.code === 'BODY_TOO_LARGE') {
          return refuseTooLarge(req, res, logger);
        }
        throw error;
      }

      if (pathname === '/webhooks/woocommerce') {
        if (isWooPing(req, rawBody)) {
          logger.log('[webhook][woocommerce] ping received');
          return sendJson(res, 200, { ok: true, ping: true });
        }

        const body = parseJsonBody(rawBody);
        if (body === null) {
          logger.warn('[webhook][woocommerce] invalid json body');
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        }

        if (!config.woo?.webhookSecret) {
          logger.warn('[webhook][woocommerce] refused: WOOCOMMERCE_WEBHOOK_SECRET is not set');
          return sendJson(res, 503, { ok: false, error: 'Webhook secret is not configured' });
        }
        const signature = req.headers['x-wc-webhook-signature'];
        const valid = verifyWooSignature(rawBody, signature, config.woo.webhookSecret);
        if (!valid) {
          logger.warn('[webhook][woocommerce] invalid signature');
          return sendJson(res, 401, { ok: false, error: 'Invalid WooCommerce signature' });
        }

        const deliveryId = req.headers['x-wc-webhook-delivery-id'] || hashEvent(rawBody);
        logger.log(`[webhook][woocommerce] received orderId=${String(body.id || '')} deliveryId=${String(deliveryId)}`);
        let result;
        try {
          result = await confirmationService.processWooOrder(body, String(deliveryId));
        } catch (error) {
          // A valid delivery is answered 200 even when processing breaks: WooCommerce disables a webhook after repeated
          // failures, and the hourly follow-ups pick the order up again from WooCommerce itself.
          logger.error(`[webhook][woocommerce] processing failed orderId=${String(body.id || '')}: ${error.message}`);
          return sendJson(res, 200, { ok: false, reason: 'processing_failed' });
        }
        logger.log(
          `[webhook][woocommerce] completed orderId=${String(body.id || '')} status=${result.status} ok=${String(result.body?.ok)} reason=${String(result.body?.reason || '')}`
        );
        return sendJson(res, result.status, result.body);
      }

      if (pathname === '/webhooks/wasender') {
        const body = parseJsonBody(rawBody);
        if (body === null) {
          logger.warn('[webhook][wasender] invalid json body');
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        }

        if (!config.wasender?.webhookSecret) {
          logger.warn('[webhook][wasender] refused: WASENDER_WEBHOOK_SECRET is not set');
          return sendJson(res, 503, { ok: false, error: 'Webhook secret is not configured' });
        }
        const signature = req.headers[config.wasender.signatureHeader];
        const valid = verifyWasenderSignature(rawBody, signature, config.wasender.webhookSecret);
        if (!valid) {
          logger.warn('[webhook][wasender] invalid signature');
          return sendJson(res, 401, { ok: false, error: 'Invalid Wasender signature' });
        }

        const eventId =
          body.id ||
          body.messageId ||
          body.data?.id ||
          req.headers['x-event-id'] ||
          hashEvent(rawBody);
        logger.log(`[webhook][wasender] received eventId=${String(eventId)}`);
        const result = await confirmationService.processWasenderInbound(body, String(eventId));
        logger.log(
          `[webhook][wasender] completed eventId=${String(eventId)} status=${result.status} ok=${String(result.body?.ok)} reason=${String(result.body?.reason || '')}`
        );
        return sendJson(res, 200, result.body);
      }

      if (pathname === '/tasks/order-followups') {
        if (!checkTaskSecret(req, res, 'task][order-followups')) {
          return undefined;
        }

        if (followupsRunning) {
          logger.warn('[task][order-followups] skipped: the previous run is still going');
          return sendJson(res, 202, { ok: true, skipped: 'already_running' });
        }
        followupsRunning = true;
        try {
          logger.log('[task][order-followups] started');
          const { result, hdStatus, followupsError } = await runHourlySteps();
          if (followupsError) {
            healthTracker?.recordRun({ ok: false, error: String(followupsError?.message || followupsError).slice(0, 120), hdStatus });
            return sendJson(res, 500, { ok: false, error: 'Follow-ups failed', hdStatus });
          }
          // The follow-ups are recorded now, so they show in the health page even if the process dies mid-sync.
          const runAt = healthTracker?.recordRun({ ok: true, summary: result, hdStatus, stockSync: null });
          const body = { ok: true, summary: result, hdStatus };
          if (!stockSyncService) {
            return sendJson(res, 200, body);
          }
          // The stock sync can take a minute: the cron call gets its answer first and the sync runs after it
          // (it has its own lock, and it can never break the follow-ups). Its summary is added to the row when it ends.
          sendJson(res, 200, body);
          runStockSyncAfterResponse(runAt);
          return undefined;
        } finally {
          followupsRunning = false;
        }
      }

      if (pathname === '/tasks/stock-sync') {
        if (!checkTaskSecret(req, res, 'task][stock-sync')) {
          return undefined;
        }
        if (!stockSyncService) {
          return sendJson(res, 503, { ok: false, error: 'Stock sync is not enabled' });
        }
        const dryRun = ['1', 'true'].includes(parsedUrl.searchParams.get('dryRun'));
        const result = await stockSyncService.run({ dryRun, approveHash: parsedUrl.searchParams.get('approve') || '' });
        if (result.skipped === 'already_running') {
          return sendJson(res, 202, { ok: true, skipped: 'already_running' });
        }
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === '/tasks/stock-alerts') {
        if (!checkTaskSecret(req, res, 'task][stock-alerts')) {
          return undefined;
        }
        if (!stockAlertService) {
          return sendJson(res, 503, { ok: false, error: 'Stock alerts are not enabled' });
        }

        const body = parseJsonBody(rawBody);
        if (body === null || !Array.isArray(body.alerts)) {
          return sendJson(res, 400, { ok: false, error: 'Body must be {"alerts": [...]}' });
        }
        if (body.alerts.length > 200) {
          return sendJson(res, 413, { ok: false, error: 'At most 200 alerts per request' });
        }

        const result = stockAlertService.accept(body.alerts);
        logger.log(`[task][stock-alerts] accepted=${result.accepted.length} skipped=${result.skipped.length}`);
        return sendJson(res, 202, { ok: true, ...result });
      }

      return sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      logger.error(error);
      return sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  };
}

// Reads the body up to maxBytes; a bigger body rejects with code BODY_TOO_LARGE and stops buffering.
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) {
        done = true;
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

// 413, then the connection is dropped so the rest of the upload is never read.
function refuseTooLarge(req, res, logger) {
  logger.warn('[http] refused a request body larger than the limit');
  res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
  if (typeof req.destroy === 'function') {
    setImmediate(() => req.destroy());
  }
  return undefined;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseJsonBody(rawBody) {
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function isWooPing(req, rawBody) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!rawBody) {
    return true;
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return rawBody.includes('webhook_id=');
  }

  return /^webhook_id=\d+/u.test(rawBody);
}

function hashEvent(input) {
  return createHash('sha256').update(input).digest('hex');
}

// No cross-origin access: the only callers are the desktop app, the cron job and server-side scripts, not browsers.
const CORS_HEADERS = {};

function sendCors(res, statusCode) {
  res.writeHead(statusCode, CORS_HEADERS);
  res.end();
}

function sendCorsJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}
