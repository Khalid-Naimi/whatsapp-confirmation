import { HttpError, request as httpRequest } from '../http/request.js';
import { Semaphore } from '../utils/semaphore.js';
import { redact } from '../log.js';

function buildAuthHeader(consumerKey, consumerSecret) {
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
}

export const PRODUCT_FIELDS = 'id,name,type,status,sku,meta_data,stock_quantity,manage_stock,backorders';
export const VARIATION_FIELDS = 'id,attributes,status,stock_quantity,manage_stock,backorders,meta_data';
export const ORDER_LITE_FIELDS = 'id,status,date_created_gmt,line_items,meta_data';
// The stock sync's open-order read stops here; other callers keep reading without a limit.
export const MAX_OPEN_ORDER_PAGES = 50;

const MAX_LIST_PAGES = 20;
const MAX_BATCH_SIZE = 100;

export class WooCommerceClient {
  constructor({ baseUrl, consumerKey, consumerSecret, fetchImpl = fetch, timeoutMs = 30000, logger = console, sleepImpl = sleep, randomImpl = Math.random, maxConcurrent = 4, maxQueueWaitMs = 60000 }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.authHeader = buildAuthHeader(consumerKey, consumerSecret);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.sleep = sleepImpl;
    this.random = randomImpl;
    // A drop can start hundreds of order handlers at once: only a few calls run at the same time, the rest wait (never
    // more than a minute) so the shop's website stays fast for customers.
    this.gate = new Semaphore({ limit: maxConcurrent, maxWaitMs: maxQueueWaitMs });
  }

  // `after` (ISO date) keeps only orders created since then. A status the shop does not know (for example the
  // "confirmed" status before the Rhymat Order Statuses plugin is active) is skipped instead of failing the whole list;
  // pass an array as `skipped` to learn which statuses were skipped.
  // `maxPages` (per status) turns a list that never ends into an error instead of an endless loop.
  async listOrdersByStatuses(statuses, { perPage = 100, after = '', fields = '', skipped = null, maxPages = Infinity } = {}) {
    const allOrders = [];
    const seenOrderIds = new Set();

    for (const status of statuses) {
      let page = 1;

      while (true) {
        if (page > maxPages) {
          throw new Error(`WooCommerce order list for status "${status}" is longer than ${maxPages} pages`);
        }
        let orders;
        try {
          orders = await this.listOrders({
            status,
            perPage,
            page,
            after,
            fields
          });
        } catch (error) {
          if (/failed with 400/u.test(String(error?.message)) && /rest_invalid_param/u.test(String(error?.message))) {
            this.logger.warn(`[woo] status "${status}" is not known to the shop; skipped in the order list`);
            skipped?.push(status);
            break;
          }
          throw error;
        }

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
  }

  async listOrders({ status, perPage = 100, page = 1, after = '', fields = '' }) {
    const params = new URLSearchParams();
    if (fields) {
      params.set('_fields', fields);
    }
    if (status) {
      params.set('status', status);
    }
    if (after) {
      params.set('after', after);
    }
    params.set('per_page', String(perPage));
    params.set('page', String(page));

    return this.request(`/wp-json/wc/v3/orders?${params.toString()}`, {
      method: 'GET'
    });
  }

  async getOrder(orderId) {
    return this.request(`/wp-json/wc/v3/orders/${orderId}`, {
      method: 'GET'
    });
  }

  // Absolute values (a status, meta values): repeating it is harmless, so it may be retried.
  async updateOrder(orderId, fields) {
    return this.request(`/wp-json/wc/v3/orders/${orderId}`, {
      method: 'PUT',
      body: fields,
      idempotent: true
    });
  }

  async updateOrderStatus(orderId, status) {
    return this.updateOrder(orderId, { status });
  }

  async updateOrderMeta(orderId, metaData) {
    return this.updateOrder(orderId, { meta_data: metaData });
  }

  // A POST that adds a note: never retried (a retry after a lost answer would add it twice).
  async addOrderNote(orderId, note) {
    return this.request(`/wp-json/wc/v3/orders/${orderId}/notes`, {
      method: 'POST',
      body: { note, customer_note: false }
    });
  }


  // Open orders with only what the stock reservation needs (no billing or shipping data).
  // -> { orders, skippedStatuses }: a status the shop rejected means its orders are missing from the list.
  async listOpenOrdersLite(statuses, { after = '' } = {}) {
    const skippedStatuses = [];
    const orders = await this.listOrdersByStatuses(statuses, { after, fields: ORDER_LITE_FIELDS, skipped: skippedStatuses, maxPages: MAX_OPEN_ORDER_PAGES });
    return { orders, skippedStatuses };
  }

  async listProductsPage({ page = 1, perPage = 100, fields = PRODUCT_FIELDS, status = 'any', sku = '' } = {}) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page), status, _fields: fields });
    if (sku) {
      params.set('sku', sku);
    }
    return this.request(`/wp-json/wc/v3/products?${params.toString()}`, { method: 'GET', idempotent: true });
  }

  async listAllProducts({ fields = PRODUCT_FIELDS } = {}) {
    return this.collectPages((page) => this.listProductsPage({ page, fields }), 'product list');
  }

  async getProduct(productId, { fields = PRODUCT_FIELDS } = {}) {
    return this.request(`/wp-json/wc/v3/products/${productId}?_fields=${fields}`, { method: 'GET', idempotent: true });
  }

  async listVariations(productId, { fields = VARIATION_FIELDS } = {}) {
    return this.collectPages(
      (page) => this.request(`/wp-json/wc/v3/products/${productId}/variations?per_page=100&page=${page}&_fields=${fields}`, { method: 'GET', idempotent: true }),
      `variation list of product ${productId}`
    );
  }

  // Absolute values only (a stock quantity, a meta document): repeating the call is harmless, so it may be retried.
  async updateProduct(productId, fields) {
    return this.request(`/wp-json/wc/v3/products/${productId}`, { method: 'PUT', body: fields, idempotent: true });
  }

  async batchUpdateVariations(productId, updates) {
    if (updates.length > MAX_BATCH_SIZE) {
      throw new Error(`A variation batch holds at most ${MAX_BATCH_SIZE} updates`);
    }
    return this.request(`/wp-json/wc/v3/products/${productId}/variations/batch`, { method: 'POST', body: { update: updates }, idempotent: true });
  }

  // Reads page after page until a short page; refuses to loop forever.
  async collectPages(readPage, what) {
    const all = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const rows = await readPage(page);
      all.push(...rows);
      if (rows.length < 100) {
        return all;
      }
    }
    throw new Error(`WooCommerce ${what} is longer than ${MAX_LIST_PAGES} pages`);
  }

  // GETs (also the order lists) are retried on no answer, 429 and 5xx; a write only when `idempotent` (absolute
  // values: an order status or meta, a stock quantity); an order note (POST) never. A GET refused with 401/403/415
  // with the header login is tried once more with the keys in the query (some hosts strip the header).
  async request(path, { method, body, idempotent = false }) {
    const authModes = method === 'GET' ? ['header', 'query'] : ['header'];
    if (shouldLogWooRequest({ method })) {
      this.logger.log(redact(`[woo] request method=${method} path=${path}${summarizeWooBody(body)}`, { secrets: this.secrets() }));
    }

    let lastError = null;
    for (const authMode of authModes) {
      let reply;
      try {
        reply = await this.gate.run(() => httpRequest({
          method,
          url: buildRequestUrl({ baseUrl: this.baseUrl, path, consumerKey: this.consumerKey, consumerSecret: this.consumerSecret, authMode }),
          headers: buildHeaders({ authHeader: this.authHeader, authMode, hasBody: body !== undefined }),
          body,
          timeoutMs: this.timeoutMs,
          retry: 'safe',
          idempotent,
          fetchImpl: this.fetch,
          sleep: this.sleep,
          random: this.random,
          secrets: this.secrets(),
          label: 'WooCommerce request',
          onRetry: ({ nextAttempt, of, error }) => this.logger.warn(redact(`[woo] ${error.kind === 'http' ? `transient failure status=${error.status}` : `no answer (${error.kind})`} method=${method} path=${path} auth=${authMode}, retry ${nextAttempt} of ${of}`, { secrets: this.secrets() }))
        }), `WooCommerce ${method} call`);
      } catch (error) {
        if (!(error instanceof HttpError) || error.kind !== 'http') {
          throw error;
        }
        this.logger.warn(redact(`[woo] failure method=${method} path=${path} auth=${authMode} status=${error.status}${summarizeWooFailureBody(error)}`, { secrets: this.secrets() }));
        lastError = buildWooError(error);
        if (shouldRetryWithQueryAuth({ method, status: error.status, authMode })) {
          continue;
        }
        throw lastError;
      }
      if (shouldLogWooSuccess({ method })) {
        this.logger.log(`[woo] success method=${method} path=${path} status=${reply.status}${summarizeWooSuccessResponse(reply.data)}`);
      }
      return reply.data;
    }
    throw lastError || new Error('WooCommerce request failed');
  }

  secrets() {
    return [this.consumerKey, this.consumerSecret];
  }
}

function buildHeaders({ authHeader, authMode, hasBody }) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'woocommerce-whatsapp-confirmation/1.0'
  };

  if (authMode === 'header') {
    headers.Authorization = authHeader;
  }

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function buildRequestUrl({ baseUrl, path, consumerKey, consumerSecret, authMode }) {
  const url = new URL(path, `${baseUrl}/`);
  if (authMode === 'query') {
    url.searchParams.set('consumer_key', consumerKey);
    url.searchParams.set('consumer_secret', consumerSecret);
  }

  return url.toString();
}

function shouldRetryWithQueryAuth({ method, status, authMode }) {
  return method === 'GET' && authMode === 'header' && [401, 403, 415].includes(status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeWooBody(body) {
  if (!body) {
    return '';
  }

  const parts = [];
  if (body.status) {
    parts.push(`targetStatus=${body.status}`);
  }

  if (Array.isArray(body.meta_data)) {
    parts.push(`metaKeys=${body.meta_data.map((item) => item.key).filter(Boolean).join(',')}`);
  }

  if (body.note) {
    parts.push('note=true');
  }

  return parts.length ? ` ${parts.join(' ')}` : '';
}

// The link documents and sync state live in rhymat_* product meta; their JSON must never reach a log or an error text.
function hideRhymatMeta(text) {
  return text.replace(/("key":"rhymat_[a-z_]+","value":)"(?:[^"\\]|\\.)*"/gu, '$1"[hidden]"');
}

function safeJson(value) {
  try {
    return hideRhymatMeta(String(JSON.stringify(value)));
  } catch {
    return '"[unserializable]"';
  }
}

function shouldLogWooRequest({ method }) {
  return method !== 'GET';
}

function shouldLogWooSuccess({ method }) {
  return method !== 'GET';
}

function summarizeWooSuccessResponse(data) {
  if (data === null || data === undefined) {
    return ' response=empty';
  }

  if (Array.isArray(data)) {
    const firstId = extractOrderId(data[0]);
    const lastId = extractOrderId(data.at(-1));
    const parts = [`count=${data.length}`];
    if (firstId) {
      parts.push(`firstOrderId=${firstId}`);
    }
    if (lastId && lastId !== firstId) {
      parts.push(`lastOrderId=${lastId}`);
    }
    return ` ${parts.join(' ')}`;
  }

  if (typeof data === 'object') {
    const orderId = extractOrderId(data);
    const orderStatus = typeof data.status === 'string' ? data.status : '';
    if (orderId || orderStatus) {
      const parts = [];
      if (orderId) {
        parts.push(`orderId=${orderId}`);
      }
      if (orderStatus) {
        parts.push(`orderStatus=${orderStatus}`);
      }
      return ` ${parts.join(' ')}`;
    }

    const keys = Object.keys(data).sort();
    return keys.length ? ` keys=${keys.join(',')}` : ' response=empty';
  }

  return ` value=${String(data)}`;
}

function extractOrderId(value) {
  if (!value || typeof value !== 'object' || !('id' in value)) {
    return '';
  }

  return String(value.id || '').trim();
}

function truncateForLog(value, maxLength = 500) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

// The log line keeps a short, redacted picture of the reply (never in an error message).
function summarizeWooFailureBody(error) {
  const { data, text: rawText, bodyFormat } = error;

  if (bodyFormat === 'json') {
    return ` bodyFormat=json body=${truncateForLog(safeJson(data))}`;
  }

  if (bodyFormat === 'text') {
    return ` bodyFormat=text bodySnippet=${JSON.stringify(truncateForLog(rawText, 200))}`;
  }

  if (bodyFormat === 'empty') {
    return ' bodyFormat=empty';
  }

  return ' bodyFormat=unreadable';
}

// The error names the status and WooCommerce's error code only (for example rest_invalid_param), never the reply
// body: it can echo customer data or the link documents. The reply stays on the error (data) for code that needs it.
function buildWooError(httpError) {
  const { status, data, bodyFormat } = httpError;
  let detail;
  if (bodyFormat === 'json') {
    const code = typeof data?.code === 'string' ? data.code.replace(/[^A-Za-z0-9_.-]/gu, '').slice(0, 80) : '';
    detail = code ? `: ${code}` : '';
  } else if (bodyFormat === 'text') {
    detail = ': non-JSON body';
  } else if (bodyFormat === 'empty') {
    detail = ': empty body';
  } else {
    detail = ': unreadable response body';
  }
  const error = new Error(`WooCommerce request failed with ${status}${detail}`);
  error.status = status;
  error.code = typeof data?.code === 'string' ? data.code : '';
  error.kind = 'http';
  error.ambiguous = httpError.ambiguous;
  error.data = data;
  return error;
}
