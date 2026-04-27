export class WordPressClient {
  constructor({ baseUrl = '', apiKey = '', logger = console } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '');
    this.apiKey = apiKey;
    this.logger = logger;
  }

  get isConfigured() {
    return Boolean(this.baseUrl);
  }

  // POST /wp-json/rhymat/v1/whatsapp/inbound
  async postInbound(data) {
    return this._post('/wp-json/rhymat/v1/whatsapp/inbound', data);
  }

  // POST /wp-json/rhymat/v1/whatsapp/contacts/{phone}/opt-out
  // phone is E.164 (e.g. +212...) — encoded for safe URL path placement
  async optOutContact(phone, data = {}) {
    const encodedPhone = encodeURIComponent(phone);
    return this._post(`/wp-json/rhymat/v1/whatsapp/contacts/${encodedPhone}/opt-out`, data);
  }

  // GET /wp-json/rhymat/v1/whatsapp/contacts?status=opted_out
  async getOptedOutContacts() {
    return this._get('/wp-json/rhymat/v1/whatsapp/contacts?status=opted_out');
  }

  async _post(path, body) {
    if (!this.isConfigured) {
      return { ok: false, skipped: true, reason: 'not_configured' };
    }

    const url = `${this.baseUrl}${path}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.logger.warn(`[wordpress-client] POST ${path} status=${res.status} response=${JSON.stringify(json)}`);
      }
      return { ok: res.ok, status: res.status, data: json };
    } catch (error) {
      this.logger.warn(`[wordpress-client] POST ${path} error=${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async _get(path) {
    if (!this.isConfigured) {
      return { ok: false, skipped: true, reason: 'not_configured' };
    }

    const url = `${this.baseUrl}${path}`;
    try {
      const res = await fetch(url, { headers: this._headers() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.logger.warn(`[wordpress-client] GET ${path} status=${res.status} response=${JSON.stringify(json)}`);
      }
      return { ok: res.ok, status: res.status, data: json };
    } catch (error) {
      this.logger.warn(`[wordpress-client] GET ${path} error=${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}
