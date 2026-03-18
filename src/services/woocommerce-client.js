function buildAuthHeader(consumerKey, consumerSecret) {
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
}

export class WooCommerceClient {
  constructor({ baseUrl, consumerKey, consumerSecret, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.authHeader = buildAuthHeader(consumerKey, consumerSecret);
    this.fetch = fetchImpl;
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
    const headers = {
      Authorization: this.authHeader
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const data = await parseJsonSafe(response);
    if (!response.ok) {
      throw new Error(`WooCommerce request failed with ${response.status}: ${JSON.stringify(data)}`);
    }

    return data;
  }
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
