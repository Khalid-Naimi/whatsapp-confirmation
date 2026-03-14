export class WasenderClient {
  constructor({ baseUrl, apiToken, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.apiToken = apiToken;
    this.fetch = fetchImpl;
  }

  async sendMessage({ to, message }) {
    const response = await this.fetch(`${this.baseUrl}/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`
      },
      body: JSON.stringify({
        to,
        text: message
      })
    });

    const data = await parseJsonSafe(response);
    if (!response.ok) {
      throw new Error(`Wasender send-message failed with ${response.status}: ${JSON.stringify(data)}`);
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
