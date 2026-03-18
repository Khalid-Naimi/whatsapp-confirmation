import { createHash } from 'node:crypto';
import { verifyGenericHmacSignature, verifyWooSignature } from './utils/signatures.js';

export function createApp({ config, confirmationService, logger = console }) {
  return async function handler(req, res) {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method !== 'POST') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }

      const rawBody = await readBody(req);

      if (req.url === '/webhooks/woocommerce') {
        if (isWooPing(req, rawBody)) {
          return sendJson(res, 200, { ok: true, ping: true });
        }

        const body = parseJsonBody(rawBody);
        if (body === null) {
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        }

        const signature = req.headers['x-wc-webhook-signature'];
        const valid = verifyWooSignature(rawBody, signature, config.woo.webhookSecret);
        if (!valid) {
          return sendJson(res, 401, { ok: false, error: 'Invalid WooCommerce signature' });
        }

        const deliveryId = req.headers['x-wc-webhook-delivery-id'] || hashEvent(rawBody);
        const result = await confirmationService.processWooOrder(body, String(deliveryId));
        return sendJson(res, result.status, result.body);
      }

      if (req.url === '/webhooks/wasender') {
        const body = parseJsonBody(rawBody);
        if (body === null) {
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        }

        const signature = req.headers[config.wasender.signatureHeader];
        const valid = verifyGenericHmacSignature(rawBody, signature, config.wasender.webhookSecret);
        if (!valid) {
          return sendJson(res, 401, { ok: false, error: 'Invalid Wasender signature' });
        }

        const eventId =
          body.id ||
          body.messageId ||
          body.data?.id ||
          req.headers['x-event-id'] ||
          hashEvent(rawBody);
        const result = await confirmationService.processWasenderInbound(body, String(eventId));
        return sendJson(res, result.status, result.body);
      }

      if (req.url === '/tasks/order-followups') {
        const providedSecret = req.headers['x-task-secret'];
        if (!config.tasks.secret || providedSecret !== config.tasks.secret) {
          return sendJson(res, 401, { ok: false, error: 'Invalid task secret' });
        }

        const result = await confirmationService.runOrderFollowups();
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
