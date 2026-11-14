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
  constructor({ baseUrl = 'https://api.highdelivery.pro/api', phone = '', password = '', fetchImpl = fetch, timeoutMs = 25000, logger = console, now = () => Date.now(), cityAliases = {} } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/u, '');
    this.phone = String(phone || '').trim();
    this.password = String(password || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.now = now;
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

  async call(method, path, { body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      // A POST that died on the wire may still have created the parcel.
      throw new HighDeliveryError(`Could not reach HighDelivery: ${error.name || 'network error'}`, { ambiguous: method !== 'GET' });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 401 && auth) {
      return { unauthorized: true };
    }
    if (!payload || typeof payload !== 'object') {
      throw new HighDeliveryError(`HighDelivery returned an unexpected reply (HTTP ${response.status}).`, { status: response.status });
    }
    if (response.status >= 400 || payload.success !== true) {
      const detail = payload.errors ?? payload.error ?? payload.data ?? '';
      throw new HighDeliveryError(String(payload.message || `HTTP ${response.status}`), {
        status: response.status,
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

  // Warehouse products with the stock HighDelivery holds for us: [{ id, name, quantity_available, ... }]. Cached for a minute.
  async listWarehouseProducts() {
    if (!this.warehouseProducts || this.now() - this.warehouseProductsAt > 60 * 1000) {
      const all = [];
      for (let page = 1; page <= 20; page += 1) {
        const payload = await this.request('GET', `/client/warehouse/products?page=${page}&limit=100`);
        const rows = payload?.data?.products;
        if (!Array.isArray(rows)) {
          throw new HighDeliveryError('HighDelivery warehouse product list is missing.');
        }
        all.push(...rows);
        const total = Number(payload?.data?.total ?? 0);
        if (rows.length === 0 || all.length >= total) {
          break;
        }
      }
      this.warehouseProducts = all;
      this.warehouseProductsAt = this.now();
    }
    return this.warehouseProducts;
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
