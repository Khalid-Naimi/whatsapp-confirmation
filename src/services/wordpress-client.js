import { HttpError, request as httpRequest } from '../http/request.js';
import { log } from '../log.js';

// Calls the Rhymat plugin on the WordPress site. Never throws: every call answers { ok, status, data } or
// { ok: false, error }. 15 s per attempt; reads are retried on no answer / 5xx, the opt-out write too (it sets an
// absolute state), the inbound copy (a create call) never.
export const WORDPRESS_TIMEOUT_MS = 15000;

export class WordPressClient {
  constructor({ baseUrl = '', apiKey = '', logger = console, fetchImpl = fetch, timeoutMs = WORDPRESS_TIMEOUT_MS, sleepImpl = undefined } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '');
    this.apiKey = apiKey;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sleep = sleepImpl;
  }

  get isConfigured() {
    return Boolean(this.baseUrl);
  }

  // POST /wp-json/rhymat/v1/whatsapp/inbound
  async postInbound(data) {
    return this._call('POST', '/wp-json/rhymat/v1/whatsapp/inbound', data, { idempotent: false });
  }

  // POST /wp-json/rhymat/v1/whatsapp/contacts/{phone}/opt-out
  // phone is E.164 (e.g. +212...) — encoded for safe URL path placement
  async optOutContact(phone, data = {}) {
    const encodedPhone = encodeURIComponent(phone);
    return this._call('POST', `/wp-json/rhymat/v1/whatsapp/contacts/${encodedPhone}/opt-out`, data, { idempotent: true });
  }

  // GET /wp-json/rhymat/v1/whatsapp/contacts?status=opted_out
  async getOptedOutContacts() {
    return this._call('GET', '/wp-json/rhymat/v1/whatsapp/contacts?status=opted_out');
  }

  async _post(path, body) {
    return this._call('POST', path, body, { idempotent: false });
  }

  async _get(path) {
    return this._call('GET', path);
  }

  async _call(method, path, body, { idempotent = false } = {}) {
    if (!this.isConfigured) {
      return { ok: false, skipped: true, reason: 'not_configured' };
    }
    try {
      const reply = await httpRequest({
        method,
        url: `${this.baseUrl}${path}`,
        headers: this._headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: this.timeoutMs,
        retry: 'safe',
        idempotent,
        fetchImpl: this.fetch,
        ...(this.sleep ? { sleep: this.sleep } : {}),
        secrets: [this.apiKey],
        label: `WordPress ${method}`
      });
      return { ok: true, status: reply.status, data: reply.data ?? {} };
    } catch (error) {
      if (error instanceof HttpError && error.kind === 'http') {
        // The path can hold a phone and the reply can echo one: log() redacts both.
        log('warn', 'wordpress_call_failed', { method, path, status: error.status, code: typeof error.data?.code === 'string' ? error.data.code.slice(0, 80) : '' }, { logger: this.logger });
        return { ok: false, status: error.status, data: error.data ?? {} };
      }
      log('warn', 'wordpress_call_failed', { method, path, reason: error?.kind || 'error', message: String(error?.message || '').slice(0, 160) }, { logger: this.logger });
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
