import { normalizePhone } from '../utils/format.js';
import { CONTROL_SKU, readMeta } from './product-links.js';
import { DURABLE_META } from '../domain/order-meta.js';

// The small records that must survive a restart, kept in WooCommerce because the server's own disk is wiped on every
// deploy: customer opt-outs ("STOP") and the outcome of each back-in-stock alert. They live as two JSON meta values on
// the hidden draft product the desktop app already keeps for the stock sync switch (SKU rhymat-sync-control); each
// writer only ever touches its own meta keys.
//
// Everything here is best effort and never throws: if WooCommerce cannot be read at boot the service still starts
// (with a clear warning), and the next write loads, merges and saves again.
//
// Two instances at once (a deploy overlap) both read, merge and write the whole value, so one could write over the
// other's new opt-out. Every save is therefore read back: after an opt-out save the read waits verifySettleMs (1 s)
// so a competing save has landed; if anything just written is missing, the value is merged again and saved once
// more, then read back again. If it is still missing it stays marked for the next write (warning in the log).
export { DURABLE_META };

export const DURABLE_LIMITS = Object.freeze({ optOuts: 5000, stockAlerts: 2000, stockAlertDays: 60 });

const SCHEMA = 1;
const FIELDS = 'id,sku,date_modified_gmt,meta_data';
const DEFAULT_STALE_RETRY_MS = 1000;
const DEFAULT_VERIFY_SETTLE_MS = 1000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
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

// Empty (never written) or a document this version understands. Anything else is not overwritten.
export function isReadableBlob(text) {
  if (!text) {
    return true;
  }
  return parseObject(text)?.schema === SCHEMA;
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
  constructor({ wooClient, wordpressClient = null, store = null, sku = CONTROL_SKU, limits = DURABLE_LIMITS, now = () => Date.now(), alerts = null, verifySettleMs = DEFAULT_VERIFY_SETTLE_MS, staleRetryMs = DEFAULT_STALE_RETRY_MS, sleep = defaultSleep, logger = console } = {}) {
    this.wooClient = wooClient;
    this.wordpressClient = wordpressClient;
    this.store = store;
    this.sku = sku;
    this.limits = { ...DURABLE_LIMITS, ...(limits || {}) };
    this.now = now;
    // How long the read-back after an opt-out save waits for a competing save to land; 0 = read back at once.
    this.verifySettleMs = Math.max(0, Number(verifySettleMs) || 0);
    // A read-back that still shows the value from before our save (a cached GET) is read once more after this long.
    this.staleRetryMs = Math.max(0, Number(staleRetryMs) || 0);
    // The team alert path (services/alerts.js); may be set after construction. One critical alert per process when
    // the control product is first found missing.
    this.alerts = alerts;
    this.controlMissingAlerted = false;
    this.sleep = sleep;
    this.logger = logger;
    this.optOuts = new Map(); // phone -> day (YYYY-MM-DD)
    this.stockAlerts = new Map(); // alert id -> { status, at (epoch seconds) }
    this.loaded = false;
    this.productId = null;
    this.lastError = '';
    this.lastSavedAt = '';
    this.dirty = new Set();
    // Bumped on every change, so a save only marks a record clean when nothing changed while it was being written.
    this.versions = { optOuts: 0, stockAlerts: 0 };
    // Stored values this version cannot read: never written over (a newer server or a hand edit may own them).
    this.unreadable = new Set();
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
      this.alertControlMissing();
      this.logger.warn(`[durable] WARNING: the hidden WooCommerce product with SKU ${this.sku} does not exist, so opt-outs and stock alert outcomes are kept only until the next restart. Open the desktop app's Matching page once to create it.`);
      return null;
    }
    this.productId = product.id;
    return product;
  }

  alertControlMissing() {
    if (this.controlMissingAlerted || !this.alerts?.alert) {
      return;
    }
    this.controlMissingAlerted = true;
    Promise.resolve(this.alerts.alert({
      key: 'durable_control_missing',
      level: 'critical',
      text: `ATTENTION serveur: le produit cache ${this.sku} est introuvable dans WooCommerce. Les desabonnements (STOP) ne sont gardes que jusqu'au prochain redemarrage. Ouvrir la page Matching de l'app desktop une fois pour le creer.`
    })).catch((error) => this.logger.warn(`[durable] control product alert failed: ${error?.message || error}`));
  }

  markDirty(key) {
    this.dirty.add(key);
    this.versions[key] += 1;
  }

  mergeRemote(product) {
    for (const [key, metaKey] of [['optOuts', DURABLE_META.optOuts], ['stockAlerts', DURABLE_META.stockAlerts]]) {
      if (isReadableBlob(readMeta(product, metaKey))) {
        this.unreadable.delete(key);
      } else if (!this.unreadable.has(key)) {
        this.unreadable.add(key);
        this.logger.warn(`[durable] WARNING: the stored ${metaKey} value cannot be read; it is left as it is (not overwritten) and ${key} stay in the local cache only`);
      }
    }
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
          this.markDirty('optOuts');
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
      this.markDirty('optOuts');
    }
    await this.flush();
    return !this.dirty.has('optOuts');
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
    this.markDirty('stockAlerts');
    await this.flush();
    return !this.dirty.has('stockAlerts');
  }

  // One write at a time; every call waits for the write that covers its change. Never throws.
  flush() {
    const run = this.chain.then(() => this.writeDirty());
    this.chain = run.catch(() => false);
    return this.chain;
  }

  async writeDirty() {
    // A change that arrives while a save is running bumps the version: the loop then saves again.
    const writable = () => [...this.dirty].filter((key) => !this.unreadable.has(key));
    for (let round = 0; round < 3 && (writable().length || !this.loaded); round += 1) {
      const saved = await this.writeOnce();
      if (!saved) {
        break;
      }
    }
    return this.dirty.size === 0;
  }

  async writeOnce() {
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
    const keys = [...this.dirty].filter((key) => !this.unreadable.has(key));
    if (!keys.length) {
      return false;
    }
    const snapshot = { ...this.versions };
    const meta = this.buildMeta(keys);
    let saved;
    try {
      saved = await this.wooClient.updateProduct(this.productId, { meta_data: meta });
    } catch (error) {
      this.lastError = 'woo_write_failed';
      this.logger.warn(`[durable] WARNING: could not save ${keys.join(', ')} to WooCommerce (${error.message}); will retry on the next write`);
      return false;
    }
    if (!(await this.confirmSaved(keys, meta, true, writeMarks(product, saved, meta)))) {
      return false;
    }
    for (const key of keys) {
      if (this.versions[key] === snapshot[key]) {
        this.dirty.delete(key);
      }
    }
    this.lastError = '';
    this.lastSavedAt = new Date(this.now()).toISOString();
    return true;
  }

  buildMeta(keys) {
    const meta = [];
    if (keys.includes('optOuts')) {
      meta.push({ key: DURABLE_META.optOuts, value: this.serializeOptOuts() });
    }
    if (keys.includes('stockAlerts')) {
      meta.push({ key: DURABLE_META.stockAlerts, value: this.serializeStockAlerts() });
    }
    return meta;
  }

  // Reads the value back after a save. Something just written that is missing means another writer saved over it in
  // the meantime: merge what is there now and save once more (retry = false on that second check).
  // `marks` tells a stale read-back apart from a real overwrite: the stored values and modification time from before
  // our save, and the modification time WooCommerce gave our save.
  async confirmSaved(keys, meta, retry = true, marks = null) {
    if (keys.includes('optOuts') && this.verifySettleMs > 0) {
      await this.sleep(this.verifySettleMs);
    }
    let product = await this.readProduct();
    if (!product) {
      // The save itself was accepted; only the check could not run.
      this.logger.warn(`[durable] could not read ${keys.join(', ')} back after saving; counted as saved`);
      return true;
    }
    let missing = missingAfterWrite(product, meta);
    if (missing.length && isStaleRead(product, marks)) {
      // The read was served from before our save (a cache): read once more after a moment before re-writing anything.
      if (this.staleRetryMs > 0) {
        await this.sleep(this.staleRetryMs);
      }
      product = await this.readProduct();
      if (!product) {
        this.logger.warn(`[durable] could not read ${keys.join(', ')} back after saving; counted as saved`);
        return true;
      }
      missing = missingAfterWrite(product, meta);
      if (missing.length && isStaleRead(product, marks)) {
        this.logger.warn(`[durable] the read-back of ${missing.join(', ')} still shows the value from before the save (cached read); counted as saved`);
        return true;
      }
    }
    if (!missing.length) {
      return true;
    }
    if (!retry) {
      this.lastError = 'overwritten';
      this.logger.warn(`[durable] WARNING: ${missing.join(', ')} were saved over by another writer again; kept for the next write`);
      return false;
    }
    this.logger.warn(`[durable] ${missing.join(', ')} were saved over by another writer (another instance?); merging and saving again`);
    this.mergeRemote(product);
    const again = keys.filter((key) => !this.unreadable.has(key));
    if (!again.length) {
      return false;
    }
    const retryMeta = this.buildMeta(again);
    try {
      await this.wooClient.updateProduct(this.productId, { meta_data: retryMeta });
    } catch (error) {
      this.lastError = 'woo_write_failed';
      this.logger.warn(`[durable] WARNING: could not save ${again.join(', ')} again (${error.message}); will retry on the next write`);
      return false;
    }
    const marksAgain = writeMarks(product, null, retryMeta);
    return this.confirmSaved(again, retryMeta, false, marksAgain);
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

// The entries of each written value that the stored value no longer has: [meta key, ...] of those with any missing.
function missingAfterWrite(product, meta) {
  const missing = [];
  for (const row of meta) {
    const stored = readMeta(product, row.key);
    if (row.key === DURABLE_META.optOuts) {
      const remote = parseOptOuts(stored);
      if ([...parseOptOuts(row.value).keys()].some((phone) => !remote.has(phone))) {
        missing.push(row.key);
      }
    } else if (row.key === DURABLE_META.stockAlerts) {
      const remote = parseStockAlerts(stored);
      if ([...parseStockAlerts(row.value).keys()].some((id) => !remote.has(id))) {
        missing.push(row.key);
      }
    }
  }
  return missing;
}

// What a read-back is compared with: the stored values before our save, the product's modification time then, and
// the one WooCommerce answered for our save (when it gives one).
function writeMarks(before, saved, meta) {
  return {
    beforeValues: Object.fromEntries(meta.map((row) => [row.key, readMeta(before, row.key)])),
    beforeModified: modifiedMs(before),
    savedModified: modifiedMs(saved)
  };
}

function modifiedMs(product) {
  const raw = String(product?.date_modified_gmt || '').trim();
  if (!raw) {
    return NaN;
  }
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw) ? raw : `${raw}Z`);
}

// A read-back is stale (served from before our save) when it is older than our save by its modification time, or,
// without times, when every value we wrote still reads exactly as it did before the save. Another writer's save would
// be at least as new as ours and carry its own changes.
function isStaleRead(product, marks) {
  if (!marks) {
    return false;
  }
  const readMs = modifiedMs(product);
  if (Number.isFinite(readMs) && Number.isFinite(marks.savedModified)) {
    return readMs < marks.savedModified;
  }
  if (Number.isFinite(readMs) && Number.isFinite(marks.beforeModified) && readMs > marks.beforeModified) {
    return false;
  }
  return Object.entries(marks.beforeValues).every(([key, value]) => readMeta(product, key) === value);
}
