import { normalizePhone } from '../utils/format.js';
import { CONTROL_SKU, readMeta } from './product-links.js';

// The small records that must survive a restart, kept in WooCommerce because the server's own disk is wiped on every
// deploy: customer opt-outs ("STOP") and the outcome of each back-in-stock alert. They live as two JSON meta values on
// the hidden draft product the desktop app already keeps for the stock sync switch (SKU rhymat-sync-control); each
// writer only ever touches its own meta keys.
//
// Everything here is best effort and never throws: if WooCommerce cannot be read at boot the service still starts
// (with a clear warning), and the next write loads, merges and saves again.
export const DURABLE_META = Object.freeze({
  optOuts: 'rhymat_server_optouts',
  stockAlerts: 'rhymat_server_stock_alerts'
});

export const DURABLE_LIMITS = Object.freeze({ optOuts: 5000, stockAlerts: 2000, stockAlertDays: 60 });

const SCHEMA = 1;
const FIELDS = 'id,sku,meta_data';
const PHONE = /^\+\d{8,15}$/u;
// WordPress unslashes meta values, so nothing that needs escaping may go into the stored JSON.
const ALERT_ID = /^[A-Za-z0-9_.:-]{1,64}$/u;
const ALERT_STATUSES = new Set(['sent', 'failed']);

export function parseOptOuts(text) {
  const phones = new Map();
  const data = parseObject(text);
  const rows = data?.schema === SCHEMA && data.phones && typeof data.phones === 'object' ? data.phones : {};
  for (const [phone, day] of Object.entries(rows)) {
    if (PHONE.test(phone)) {
      phones.set(phone, /^\d{4}-\d{2}-\d{2}$/u.test(String(day)) ? String(day) : '');
    }
  }
  return phones;
}

export function parseStockAlerts(text) {
  const alerts = new Map();
  const data = parseObject(text);
  const rows = data?.schema === SCHEMA && data.alerts && typeof data.alerts === 'object' ? data.alerts : {};
  for (const [id, value] of Object.entries(rows)) {
    const [status, at] = Array.isArray(value) ? value : [];
    if (ALERT_ID.test(id) && ALERT_STATUSES.has(status) && Number.isFinite(Number(at))) {
      alerts.set(id, { status, at: Number(at) });
    }
  }
  return alerts;
}

function parseObject(text) {
  if (!text) {
    return null;
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export class DurableState {
  constructor({ wooClient, wordpressClient = null, store = null, sku = CONTROL_SKU, limits = DURABLE_LIMITS, now = () => Date.now(), logger = console } = {}) {
    this.wooClient = wooClient;
    this.wordpressClient = wordpressClient;
    this.store = store;
    this.sku = sku;
    this.limits = { ...DURABLE_LIMITS, ...(limits || {}) };
    this.now = now;
    this.logger = logger;
    this.optOuts = new Map(); // phone -> day (YYYY-MM-DD)
    this.stockAlerts = new Map(); // alert id -> { status, at (epoch seconds) }
    this.loaded = false;
    this.productId = null;
    this.lastError = '';
    this.lastSavedAt = '';
    this.dirty = new Set();
    this.chain = Promise.resolve();
    this.loading = null;
  }

  status() {
    return { loaded: this.loaded, error: this.lastError, optOuts: this.optOuts.size, stockAlerts: this.stockAlerts.size, pendingWrites: [...this.dirty], lastSavedAt: this.lastSavedAt };
  }

  // Reads the records from WooCommerce (and the WordPress opt-out list when that is configured). Never throws.
  load() {
    if (!this.loading) {
      this.loading = this.loadOnce().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async ensureLoaded() {
    if (!this.loaded) {
      await this.load();
    }
    return this.loaded;
  }

  async loadOnce() {
    const product = await this.readProduct();
    if (product) {
      this.mergeRemote(product);
      this.loaded = true;
      this.lastError = '';
      this.logger.log(`[durable] loaded from WooCommerce: ${this.optOuts.size} opt-outs, ${this.stockAlerts.size} stock alert outcomes`);
    }
    await this.mergeWordPressOptOuts();
    this.copyOptOutsToStore();
    if (this.loaded && this.dirty.size) {
      await this.flush();
    }
    return { ok: this.loaded, error: this.lastError };
  }

  async readProduct() {
    let rows;
    try {
      rows = await this.wooClient.listProductsPage({ sku: this.sku, perPage: 1, fields: FIELDS });
    } catch (error) {
      this.lastError = 'woo_read_failed';
      this.logger.warn(`[durable] WARNING: could not read the opt-outs and stock alert outcomes from WooCommerce (${error.message}); running on the local cache, will retry on the next write`);
      return null;
    }
    const product = (Array.isArray(rows) ? rows : []).find((row) => row?.sku === this.sku);
    if (!product) {
      this.lastError = 'control_missing';
      this.logger.warn(`[durable] WARNING: the hidden WooCommerce product with SKU ${this.sku} does not exist, so opt-outs and stock alert outcomes are kept only until the next restart. Open the desktop app's Matching page once to create it.`);
      return null;
    }
    this.productId = product.id;
    return product;
  }

  mergeRemote(product) {
    for (const [phone, day] of parseOptOuts(readMeta(product, DURABLE_META.optOuts))) {
      if (!this.optOuts.has(phone)) {
        this.optOuts.set(phone, day);
      }
    }
    for (const [id, remote] of parseStockAlerts(readMeta(product, DURABLE_META.stockAlerts))) {
      const local = this.stockAlerts.get(id);
      if (!local || local.at < remote.at) {
        this.stockAlerts.set(id, remote);
      }
    }
  }

  async mergeWordPressOptOuts() {
    if (!this.wordpressClient?.isConfigured || typeof this.wordpressClient.getOptedOutContacts !== 'function') {
      return;
    }
    try {
      const result = await this.wordpressClient.getOptedOutContacts();
      if (!result?.ok) {
        return;
      }
      const data = result.data;
      const rows = Array.isArray(data) ? data : (data?.contacts || data?.items || data?.data || []);
      let added = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const phone = normalizePhone(typeof row === 'string' ? row : row?.phone);
        if (PHONE.test(phone) && !this.optOuts.has(phone)) {
          this.optOuts.set(phone, String(row?.optedOutAt || row?.opted_out_at || '').slice(0, 10));
          this.dirty.add('optOuts');
          added += 1;
        }
      }
      if (added) {
        this.logger.log(`[durable] ${added} opt-outs added from WordPress`);
      }
    } catch (error) {
      this.logger.warn(`[durable] WordPress opt-out list unavailable: ${error.message}`);
    }
  }

  // The local JSON store stays the fast cache that every send path already asks (isPhoneOptedOut).
  copyOptOutsToStore() {
    if (!this.store) {
      return;
    }
    try {
      for (const [phone, day] of this.optOuts) {
        if (!this.store.isPhoneOptedOut(phone)) {
          this.store.upsertContact({ phone, marketingStatus: 'opted_out', optedOutAt: day, optOutSource: 'durable_restore' });
        }
      }
    } catch (error) {
      this.logger.warn(`[durable] could not copy the opt-outs to the local cache: ${error.message}`);
    }
  }

  isOptedOut(phone) {
    return this.optOuts.has(String(phone || ''));
  }

  // Saved at once (awaited by the caller); false when it could not be saved yet (it is retried on the next write).
  async recordOptOut(phone, at = new Date(this.now()).toISOString()) {
    if (!PHONE.test(String(phone || ''))) {
      return false;
    }
    if (!this.optOuts.has(phone)) {
      this.optOuts.set(phone, String(at).slice(0, 10));
      this.dirty.add('optOuts');
    }
    return this.flush();
  }

  stockAlertStatus(id) {
    return this.stockAlerts.get(String(id))?.status || '';
  }

  async recordStockAlert(id, status) {
    const key = String(id ?? '');
    if (!ALERT_ID.test(key) || !ALERT_STATUSES.has(status)) {
      return false;
    }
    this.stockAlerts.set(key, { status, at: Math.floor(this.now() / 1000) });
    this.dirty.add('stockAlerts');
    return this.flush();
  }

  // One write at a time; every call waits for the write that covers its change. Never throws.
  flush() {
    const run = this.chain.then(() => this.writeDirty());
    this.chain = run.catch(() => false);
    return this.chain;
  }

  async writeDirty() {
    if (!this.dirty.size) {
      return true;
    }
    // Load (or reload) first and merge, so a write never replaces records it has not seen.
    const product = await this.readProduct();
    if (!product) {
      return false;
    }
    this.mergeRemote(product);
    if (!this.loaded) {
      this.loaded = true;
      this.copyOptOutsToStore();
    }
    const keys = [...this.dirty];
    const meta = [];
    if (keys.includes('optOuts')) {
      meta.push({ key: DURABLE_META.optOuts, value: this.serializeOptOuts() });
    }
    if (keys.includes('stockAlerts')) {
      meta.push({ key: DURABLE_META.stockAlerts, value: this.serializeStockAlerts() });
    }
    try {
      await this.wooClient.updateProduct(this.productId, { meta_data: meta });
    } catch (error) {
      this.lastError = 'woo_write_failed';
      this.logger.warn(`[durable] WARNING: could not save ${keys.join(', ')} to WooCommerce (${error.message}); will retry on the next write`);
      return false;
    }
    for (const key of keys) {
      this.dirty.delete(key);
    }
    this.lastError = '';
    this.lastSavedAt = new Date(this.now()).toISOString();
    return true;
  }

  serializeOptOuts() {
    const rows = [...this.optOuts.entries()].sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    if (rows.length > this.limits.optOuts) {
      this.logger.warn(`[durable] more than ${this.limits.optOuts} opt-outs: the oldest ${rows.length - this.limits.optOuts} are no longer saved durably`);
    }
    return JSON.stringify({ schema: SCHEMA, phones: Object.fromEntries(rows.slice(0, this.limits.optOuts)) });
  }

  serializeStockAlerts() {
    const cutoff = Math.floor(this.now() / 1000) - this.limits.stockAlertDays * 24 * 60 * 60;
    for (const [id, alert] of this.stockAlerts) {
      if (alert.at < cutoff) {
        this.stockAlerts.delete(id);
      }
    }
    const rows = [...this.stockAlerts.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, this.limits.stockAlerts);
    this.stockAlerts = new Map(rows);
    return JSON.stringify({ schema: SCHEMA, alerts: Object.fromEntries(rows.map(([id, alert]) => [id, [alert.status, alert.at]])) });
  }
}
