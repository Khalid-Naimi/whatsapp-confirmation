import { HttpError, request as httpRequest } from '../http/request.js';

// Client for the new HighDelivery platform API (app.highdelivery.pro).
// Only what the auto-send needs: log in, read the served cities and the warehouse stock, check a phone number, create (and cancel) one parcel.
// Every refusal keeps the HTTP status and the server reply so the Woo order note can say what was rejected.

export class HighDeliveryError extends Error {
  constructor(message, { status = null, body = '', ambiguous = false } = {}) {
    super(message);
    this.name = 'HighDeliveryError';
    this.status = status;
    this.body = String(body || '').slice(0, 1500);
    // true when the request may have reached the platform even though we got no answer (timeout, dropped connection)
    this.ambiguous = ambiguous;
  }

  detail() {
    const parts = [this.message];
    if (this.status) {
      parts.push(`HTTP ${this.status}`);
    }
    if (this.body && !this.message.includes(this.body)) {
      parts.push(`server reply: ${this.body}`);
    }
    return parts.join(' | ');
  }
}

export function foldText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}

export function extractTrackingNumber(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractTrackingNumber(item);
      if (found) {
        return found;
      }
    }
    return '';
  }
  if (data && typeof data === 'object') {
    for (const key of ['tracking_number', 'trackingNumber']) {
      if (data[key]) {
        return String(data[key]);
      }
    }
    for (const value of Object.values(data)) {
      const found = extractTrackingNumber(value);
      if (found) {
        return found;
      }
    }
  }
  return '';
}

const CITY_CACHE_MS = 6 * 60 * 60 * 1000;

export class HighDeliveryClient {
  constructor({ baseUrl = 'https://api.highdelivery.pro/api', phone = '', password = '', fetchImpl = fetch, timeoutMs = 25000, logger = console, now = () => Date.now(), cityAliases = {}, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
    this.phone = String(phone || '').trim();
    this.password = String(password || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.now = now;
    this.sleep = sleepImpl;
    this.token = '';
    this.cities = null;
    this.citiesAt = 0;
    this.warehouseProducts = null;
    this.warehouseProductsAt = 0;
    // Old website spellings of a town -> the name HighDelivery uses (checked once, by a human).
    this.cityAliases = new Map(Object.entries(cityAliases || {}).map(([from, to]) => [foldText(from), String(to)]));
  }

  isConfigured() {
    return Boolean(this.phone && this.password);
  }

  // Reads are retried on no answer / 5xx by the HTTP layer; writes (login, parcel creation, cancel) are never repeated.
  async call(method, path, { body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    // A write (not the login) may have been carried out even when its answer is broken: such failures are ambiguous.
    const mayHaveActed = method !== 'GET' && auth;
    let status;
    let payload;
    try {
      const reply = await httpRequest({
        method,
        url: `${this.baseUrl}${path}`,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: this.timeoutMs,
        retry: method === 'GET' ? 'safe' : 'none',
        baseDelayMs: 500,
        fetchImpl: this.fetchImpl,
        sleep: this.sleep,
        secrets: [this.password, this.token],
        label: 'HighDelivery'
      });
      status = reply.status;
      payload = reply.data;
    } catch (error) {
      if (!(error instanceof HttpError) || error.kind !== 'http') {
        // A POST that died on the wire may still have created the parcel.
        const reason = error?.kind === 'timeout' ? 'TimeoutError' : (error?.kind === 'network' ? 'network error' : (error?.name || 'network error'));
        throw new HighDeliveryError(`Could not reach HighDelivery: ${reason}`, { ambiguous: method !== 'GET' });
      }
      status = error.status;
      payload = error.data;
    }

    if (status === 401 && auth) {
      return { unauthorized: true };
    }
    if (!payload || typeof payload !== 'object') {
      throw new HighDeliveryError(`HighDelivery returned an unexpected reply (HTTP ${status}).`, { status, ambiguous: mayHaveActed });
    }
    if (status >= 500 && mayHaveActed) {
      // A server error after a write: the parcel may exist, so this is never treated as a clean refusal.
      const detail = payload.errors ?? payload.error ?? payload.data ?? '';
      throw new HighDeliveryError(String(payload.message || `HTTP ${status}`), {
        status,
        body: typeof detail === 'string' ? detail : JSON.stringify(detail),
        ambiguous: true
      });
    }
    if (status >= 400 || payload.success !== true) {
      const detail = payload.errors ?? payload.error ?? payload.data ?? '';
      throw new HighDeliveryError(String(payload.message || `HTTP ${status}`), {
        status,
        body: typeof detail === 'string' ? detail : JSON.stringify(detail)
      });
    }
    return payload;
  }

  async login() {
    if (!this.isConfigured()) {
      throw new HighDeliveryError('HighDelivery phone and password are not set.');
    }
    const payload = await this.call('POST', '/auth/login', { body: { phone: this.phone, password: this.password }, auth: false });
    const token = String(payload?.data?.token || '').trim();
    if (!token) {
      throw new HighDeliveryError('HighDelivery login did not return a token.');
    }
    this.token = token;
  }

  async request(method, path, body) {
    if (!this.token) {
      await this.login();
    }
    let payload = await this.call(method, path, { body });
    if (payload.unauthorized) {
      await this.login(); // token expired: log in once more, then retry once
      payload = await this.call(method, path, { body });
      if (payload.unauthorized) {
        throw new HighDeliveryError('HighDelivery rejected the login token.', { status: 401 });
      }
    }
    return payload;
  }

  async listCities() {
    if (!this.cities || this.now() - this.citiesAt > CITY_CACHE_MS) {
      const payload = await this.request('GET', '/cities?activeOnly=true');
      const cities = payload?.data?.cities;
      if (!Array.isArray(cities)) {
        throw new HighDeliveryError('HighDelivery city list is missing.');
      }
      this.cities = cities;
      this.citiesAt = this.now();
    }
    return this.cities;
  }

  async resolveCity(name) {
    const wanted = foldText(name);
    if (!wanted) {
      return null;
    }
    const cities = await this.listCities();
    const direct = cities.find((row) => foldText(row?.name_fr) === wanted);
    if (direct) {
      return direct;
    }
    const alias = this.cityAliases.get(wanted);
    return alias ? cities.find((row) => foldText(row?.name_fr) === foldText(alias)) || null : null;
  }

  // Warehouse products with the stock HighDelivery holds for us: [{ id, name, quantity_available, ... }]. Cached for a minute;
  // `fresh: true` (the stock sync) always reads again.
  async listWarehouseProducts({ fresh = false } = {}) {
    if (fresh || !this.warehouseProducts || this.now() - this.warehouseProductsAt > 60 * 1000) {
      const all = [];
      let complete = false;
      for (let page = 1; page <= 20 && !complete; page += 1) {
        const payload = await this.request('GET', `/client/warehouse/products?page=${page}&limit=100`);
        const rows = payload?.data?.products;
        if (!Array.isArray(rows)) {
          throw new HighDeliveryError('HighDelivery warehouse product list is missing.');
        }
        all.push(...rows);
        // Without a usable total the only sign of the last page is a short one: never stop at the first page by guessing.
        const total = Number(payload?.data?.total);
        complete = rows.length === 0 || (Number.isFinite(total) && total > 0 ? all.length >= total : rows.length < 100);
      }
      if (!complete) {
        throw new HighDeliveryError('HighDelivery warehouse product list is longer than 20 pages.');
      }
      this.warehouseProducts = all;
      this.warehouseProductsAt = this.now();
    }
    return this.warehouseProducts;
  }

  // Every parcel of the account, newest data: [{ tracking_number, status, ... }].
  async listPackages() {
    const all = [];
    for (let page = 1; page <= 50; page += 1) {
      const payload = await this.request('GET', `/client/packages?page=${page}&limit=100`);
      const rows = payload?.data?.packages;
      if (!Array.isArray(rows)) {
        throw new HighDeliveryError('HighDelivery parcel list is missing.');
      }
      all.push(...rows);
      const total = Number(payload?.data?.total);
      if (rows.length < 100 || (Number.isFinite(total) && total > 0 && all.length >= total)) {
        return all;
      }
    }
    this.logger.warn('[hd] parcel list hit the 50-page cap; newer parcels may be missing');
    return all;
  }

  // The platform's own check of a phone number: how many parcels it took, how many were delivered, whether it is blacklisted.
  // Returns { score, totalOrders, deliveredOrders, failedOrders, blacklisted }. A brand-new number scores 50.
  async trustScore(phone) {
    const digits = String(phone || '').replace(/[\s\-+]/gu, '');
    const payload = await this.request('GET', `/client/packages/trust-score?phone=${encodeURIComponent(digits)}`);
    const data = payload?.data || {};
    const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
      score: number(data.trustScore ?? data.trust_score, 50),
      totalOrders: number(data.totalOrders ?? data.total_orders),
      deliveredOrders: number(data.deliveredOrders ?? data.delivered_orders),
      failedOrders: number(data.failedOrders ?? data.failed_orders),
      blacklisted: Boolean(data.isBlacklisted ?? data.is_blacklisted)
    };
  }

  // Cancels a parcel (warehouse stock is credited back by the platform).
  async cancelPackage(id, reason = '') {
    const payload = await this.request('PUT', `/client/packages/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
    return payload.data || {};
  }

  // Edits a parcel the way the platform's own web app does: the whole delivery data goes back, with `patch` on top.
  // `row` is the parcel as the list gives it. Nothing is sent when a field that must not get lost is missing.
  async updatePackage(row, patch) {
    const id = row?.id ?? row?._id;
    const missing = ['recipient_name', 'recipient_phone', 'address', 'city', 'product_name', 'cod_amount']
      .filter((key) => row?.[key] === undefined || row?.[key] === null || row?.[key] === '');
    if (id === undefined || id === null || missing.length) {
      throw new HighDeliveryError(`The parcel cannot be edited safely (missing: ${missing.join(', ') || 'id'}).`);
    }
    const express = Boolean(row.is_express ?? row.isExpress);
    const body = {
      recipient_name: row.recipient_name,
      recipient_phone: row.recipient_phone,
      recipient_phone2: row.recipient_phone2 ?? null,
      address: row.address,
      allow_opening: Boolean(row.allow_opening ?? true),
      comment: row.comment ?? null,
      city: row.city,
      product_name: row.product_name,
      cod_amount: Number(row.cod_amount),
      is_fragile: Boolean(row.is_fragile),
      is_express: express,
      // Parcel creation only honours the camelCase name; sent both ways so an edit never drops the express choice.
      isExpress: express,
      ...patch
    };
    const payload = await this.request('PUT', `/client/packages/${encodeURIComponent(id)}`, body);
    return payload.data || {};
  }

  // The platform's own exchange of a delivered parcel: a new linked parcel to the same recipient. The body is the one
  // its web app sends. Warehouse items win over a typed product name. Returns { trackingNumber, data }.
  async createExchange(id, { codAmount = 0, productName = '', warehouseItems = [] }) {
    const body = { cod_amount: Math.round(Number(codAmount) || 0) };
    if (warehouseItems.length) {
      body.warehouseItems = warehouseItems;
    } else if (productName) {
      body.product_name = productName;
    }
    const payload = await this.request('POST', `/client/packages/${encodeURIComponent(id)}/exchange`, body);
    const data = payload.data || {};
    return { trackingNumber: extractTrackingNumber(data), data };
  }

  // Creates one parcel. Returns { trackingNumber, data }.
  async createPackage({ recipientName, recipientPhone, address, city, productName, codAmount, comment = '', allowOpening = true, isExpress = false, items = [] }) {
    const cityRow = await this.resolveCity(city);
    if (!cityRow) {
      throw new HighDeliveryError(`City '${city}' is not served by the new HighDelivery platform.`);
    }
    const body = {
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      address,
      city: String(cityRow.name_fr || city),
      product_name: productName,
      cod_amount: Math.round(Number(codAmount) || 0),
      allow_opening: Boolean(allowOpening),
      is_express: Boolean(isExpress),
      // Verified against the live API: only the camelCase name makes a parcel express (fee 50 instead of 40 in Rabat).
      isExpress: Boolean(isExpress)
    };
    if (comment) {
      body.comment = comment;
    }
    // Parcels made from our warehouse stock must name the stock products and quantities (the platform answers
    // "Sélectionnez au moins un produit du stock entrepôt et sa quantité" otherwise).
    if (Array.isArray(items) && items.length > 0) {
      body.from_warehouse = true;
      body.items = items.map((item) => ({
        source: 'warehouse',
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: 0
      }));
    }

    let payload;
    try {
      payload = await this.request('POST', '/client/packages', body);
    } catch (error) {
      // The server may want the city by id instead of by name: retry once with the id it asked for.
      const wantsCityId = error instanceof HighDeliveryError
        && [400, 422].includes(error.status)
        && `${error.message} ${error.body}`.toLowerCase().includes('city_id')
        && cityRow.id !== undefined && cityRow.id !== null;
      if (!wantsCityId) {
        throw error;
      }
      payload = await this.request('POST', '/client/packages', { ...body, city_id: cityRow.id });
    }
    const data = payload.data || {};
    return { trackingNumber: extractTrackingNumber(data), data };
  }
}
