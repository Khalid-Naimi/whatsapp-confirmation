function buildAuthHeader(consumerKey, consumerSecret) {
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
}

export class WooCommerceClient {
  constructor({ baseUrl, consumerKey, consumerSecret, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.authHeader = buildAuthHeader(consumerKey, consumerSecret);
    this.fetch = fetchImpl;
  }

  async updateOrderStatus(orderId, status) {
    return this.request(`/wp-json/wc/v3/orders/${orderId}`, {
      method: 'PUT',
      body: { status }
    });
  }

  async addOrderNote(orderId, note) {
    return this.request(`/wp-json/wc/v3/orders/${orderId}/notes`, {
      method: 'POST',
      body: { note }
    });
  }

  async request(path, { method, body }) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader
      },
      body: JSON.stringify(body)
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
