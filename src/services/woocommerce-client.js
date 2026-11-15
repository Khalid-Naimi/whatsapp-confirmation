function buildAuthHeader(consumerKey, consumerSecret) {
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
}

export const PRODUCT_FIELDS = 'id,name,type,status,sku,meta_data,stock_quantity,manage_stock,backorders';
export const VARIATION_FIELDS = 'id,attributes,status,stock_quantity,manage_stock,backorders,meta_data';
export const ORDER_LITE_FIELDS = 'id,status,line_items,meta_data';

const MAX_LIST_PAGES = 20;
const MAX_BATCH_SIZE = 100;

export class WooCommerceClient {
  constructor({ baseUrl, consumerKey, consumerSecret, fetchImpl = fetch, timeoutMs = 30000, logger = console, sleepImpl = sleep }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.authHeader = buildAuthHeader(consumerKey, consumerSecret);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.sleep = sleepImpl;
  }

  // `after` (ISO date) keeps only orders created since then. A status the shop does not know (for example the
  // "confirmed" status before the Rhymat Order Statuses plugin is active) is skipped instead of failing the whole list;
  // pass an array as `skipped` to learn which statuses were skipped.
  async listOrdersByStatuses(statuses, { perPage = 100, after = '', fields = '', skipped = null } = {}) {
    const allOrders = [];
    const seenOrderIds = new Set();

    for (const status of statuses) {
      let page = 1;

      while (true) {
        // Same limit as collectPages: a list that never ends is an error, not an endless loop.
        if (page > MAX_LIST_PAGES) {
          throw new Error(`WooCommerce order list for status "${status}" is longer than ${MAX_LIST_PAGES} pages`);
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

  async updateOrder(orderId, fields) {
    return this.request(`/wp-json/wc/v3/orders/${orderId}`, {
      method: 'PUT',
      body: fields
    });
  }

  async updateOrderStatus(orderId, status) {
    return this.updateOrder(orderId, { status });
  }

  async updateOrderMeta(orderId, metaData) {
    return this.updateOrder(orderId, { meta_data: metaData });
  }

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
    const orders = await this.listOrdersByStatuses(statuses, { after, fields: ORDER_LITE_FIELDS, skipped: skippedStatuses });
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

  async request(path, { method, body, idempotent = false }) {
    const authStrategies = [{ mode: 'header' }];
    if (method === 'GET') {
      authStrategies.push({ mode: 'query' });
    }

    let lastError = null;

    for (const strategy of authStrategies) {
      const maxAttempts = shouldRetryTransient(method, idempotent) ? 3 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          await this.sleep(1000 * (attempt - 1));
        }

        if (shouldLogWooRequest({ method })) {
          this.logger.log(`[woo] request method=${method} path=${path} auth=${strategy.mode}${attempt > 1 ? ` attempt=${attempt}` : ''}${summarizeWooBody(body)}`);
        }

        let response;
        try {
          response = await this.fetch(buildRequestUrl({
            baseUrl: this.baseUrl,
            path,
            consumerKey: this.consumerKey,
            consumerSecret: this.consumerSecret,
            authMode: strategy.mode
          }), {
            method,
            headers: buildHeaders({
              authHeader: this.authHeader,
              authMode: strategy.mode,
              hasBody: body !== undefined
            }),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs)
          });
        } catch (networkError) {
          lastError = networkError;
          if (attempt < maxAttempts) {
            this.logger.warn(`[woo] network error method=${method} path=${path} attempt=${attempt} message=${networkError.message} — retrying`);
            continue;
          }
          throw networkError;
        }

        const parsedBody = await parseResponseBody(response);
        const data = parsedBody.data;
        if (response.ok) {
          if (shouldLogWooSuccess({ method })) {
            this.logger.log(
              `[woo] success method=${method} path=${path} status=${response.status}${summarizeWooSuccessResponse(data)}`
            );
          }
          return data;
        }

        this.logger.warn(
          `[woo] failure method=${method} path=${path} auth=${strategy.mode} status=${response.status}${summarizeWooFailureBody(parsedBody)}`
        );
        lastError = buildWooError(response.status, parsedBody);

        if (shouldRetryWithQueryAuth({ method, status: response.status, authMode: strategy.mode })) {
          break;
        }

        if (attempt < maxAttempts && isTransientStatus(response.status)) {
          this.logger.warn(`[woo] transient failure method=${method} path=${path} status=${response.status} attempt=${attempt} — retrying`);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error('WooCommerce request failed');
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

// Writes are retried today; reads only when the caller says a repeat is harmless (idempotent).
function shouldRetryTransient(method, idempotent) {
  return idempotent || method !== 'GET';
}

function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function parseResponseBody(response) {
  if (typeof response?.text === 'function') {
    try {
      const rawText = await response.text();
      if (!rawText) {
        return { data: null, rawText: '', bodyFormat: 'empty' };
      }

      try {
        return {
          data: JSON.parse(rawText),
          rawText,
          bodyFormat: 'json'
        };
      } catch {
        return {
          data: null,
          rawText,
          bodyFormat: 'text'
        };
      }
    } catch {
      return { data: null, rawText: '', bodyFormat: 'unreadable' };
    }
  }

  const data = await parseJsonSafe(response);
  return {
    data,
    rawText: '',
    bodyFormat: 'json'
  };
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

function summarizeWooFailureBody(parsedBody) {
  const { data, rawText, bodyFormat } = parsedBody;

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

function buildWooError(status, parsedBody) {
  const { data, rawText, bodyFormat } = parsedBody;

  if (bodyFormat === 'json') {
    return new Error(`WooCommerce request failed with ${status}: ${safeJson(data)}`);
  }

  if (bodyFormat === 'text') {
    return new Error(
      `WooCommerce request failed with ${status}: non-JSON body ${JSON.stringify(truncateForLog(rawText, 200))}`
    );
  }

  if (bodyFormat === 'empty') {
    return new Error(`WooCommerce request failed with ${status}: empty body`);
  }

  return new Error(`WooCommerce request failed with ${status}: unreadable response body`);
}
