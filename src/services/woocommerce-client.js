function buildAuthHeader(consumerKey, consumerSecret) {
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
}

export class WooCommerceClient {
  constructor({ baseUrl, consumerKey, consumerSecret, fetchImpl = fetch, logger = console }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.authHeader = buildAuthHeader(consumerKey, consumerSecret);
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async listOrdersByStatuses(statuses, { perPage = 100 } = {}) {
    const allOrders = [];
    const seenOrderIds = new Set();

    for (const status of statuses) {
      let page = 1;

      while (true) {
        const orders = await this.listOrders({
          status,
          perPage,
          page
        });

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

  async listOrders({ status, perPage = 100, page = 1 }) {
    const params = new URLSearchParams();
    if (status) {
      params.set('status', status);
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
      body: { note }
    });
  }

  async request(path, { method, body }) {
    const authStrategies = [{ mode: 'header' }];
    if (method === 'GET') {
      authStrategies.push({ mode: 'query' });
    }

    let lastError = null;

    for (const strategy of authStrategies) {
      const maxAttempts = shouldRetryTransient(method) ? 3 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          await sleep(1000);
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
            body: body === undefined ? undefined : JSON.stringify(body)
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

function shouldRetryTransient(method) {
  return method !== 'GET';
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

function safeJson(value) {
  try {
    return JSON.stringify(value);
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
    return new Error(`WooCommerce request failed with ${status}: ${JSON.stringify(data)}`);
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
