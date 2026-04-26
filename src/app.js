import { createHash } from 'node:crypto';
import { verifyWasenderSignature, verifyWooSignature } from './utils/signatures.js';

export function createApp({ config, confirmationService, store, logger = console }) {
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

      if (req.method === 'GET' && pathname.startsWith('/api/')) {
        const providedSecret = req.headers['x-task-secret'];
        if (!config.tasks.secret || providedSecret !== config.tasks.secret) {
          return sendCorsJson(res, 401, { ok: false, error: 'Invalid task secret' });
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

        return sendCorsJson(res, 404, { ok: false, error: 'Not found' });
      }

      if (req.method !== 'POST') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }

      const rawBody = await readBody(req);

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

        const signature = req.headers['x-wc-webhook-signature'];
        const valid = verifyWooSignature(rawBody, signature, config.woo.webhookSecret);
        if (!valid) {
          logger.warn('[webhook][woocommerce] invalid signature');
          return sendJson(res, 401, { ok: false, error: 'Invalid WooCommerce signature' });
        }

        const deliveryId = req.headers['x-wc-webhook-delivery-id'] || hashEvent(rawBody);
        logger.log(`[webhook][woocommerce] received orderId=${String(body.id || '')} deliveryId=${String(deliveryId)}`);
        const result = await confirmationService.processWooOrder(body, String(deliveryId));
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
        const providedSecret = req.headers['x-task-secret'];
        if (!config.tasks.secret || providedSecret !== config.tasks.secret) {
          logger.warn('[task][order-followups] invalid task secret');
          return sendJson(res, 401, { ok: false, error: 'Invalid task secret' });
        }

        logger.log('[task][order-followups] started');
        const result = await confirmationService.runOrderFollowups();
        logger.log(
          `[task][order-followups] completed backfilled=${result.backfilled || 0} remindersSent=${result.remindersSent || 0} autoCancelled=${result.autoCancelled || 0} skipped=${result.skipped || 0} errors=${result.errors || 0}`
        );
        return sendJson(res, 200, { ok: true, summary: result });
      }

      return sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      logger.error(error);
      return sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-task-secret'
};

function sendCors(res, statusCode) {
  res.writeHead(statusCode, CORS_HEADERS);
  res.end();
}

function sendCorsJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}
