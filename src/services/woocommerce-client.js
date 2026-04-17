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

        this.logger.log(`[woo] request method=${method} path=${path} auth=${strategy.mode}${attempt > 1 ? ` attempt=${attempt}` : ''}${summarizeWooBody(body)}`);

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

        const data = await parseJsonSafe(response);
        if (response.ok) {
          this.logger.log(`[woo] success method=${method} path=${path} status=${response.status}`);
          return data;
        }

        this.logger.warn(`[woo] failure method=${method} path=${path} status=${response.status} body=${safeJson(data)}`);
        lastError = new Error(`WooCommerce request failed with ${response.status}: ${JSON.stringify(data)}`);

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
