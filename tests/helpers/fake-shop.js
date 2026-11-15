import { CONTROL_SKU, LINK_META, canonicalJson } from '../../src/services/product-links.js';
import { loadProductMap } from '../../src/services/hd-product-match.js';
import { LinkIndex } from '../../src/services/link-index.js';
import { StockSyncService } from '../../src/services/stock-sync-service.js';
import { SyncControl } from '../../src/services/sync-control.js';
import { linkDoc, linkUnit, metaRow, wooProduct, wooVariation } from './link-fixtures.js';

export const quietLogger = { log() {}, warn() {}, error() {} };

export const STOCK_CONFIG = {
  mode: 'live', maxChangedUnits: 10, maxTotalDelta: 40, maxRestocks: 5, maxSingleIncrease: 20, minHdItems: 5,
  reserveStatuses: ['processing', 'on-hold'], writeDelayMs: 0
};

export const NOW = new Date('2026-11-15T10:00:00Z');

export const controlProduct = (control = { schema: 1, rev: 1, paused: false, ignored_hd_ids: [] }, state = null) => {
  const product = wooProduct(1, { sku: CONTROL_SKU, status: 'private' });
  product.meta_data.push(metaRow(LINK_META.control, control));
  if (state) {
    product.meta_data.push(metaRow(LINK_META.state, state));
  }
  return product;
};

export const hdRows = (...pairs) => pairs.map(([id, quantity, name]) => ({ id, name: name || `HD item ${id}`, quantity_available: quantity }));
// Enough filler rows so the "too few HighDelivery items" guard is not what a test trips over.
export const FILLER = hdRows([901, 3], [902, 3], [903, 3], [904, 3], [905, 3]);

// A small in-memory WooCommerce that records every write. It stands in for the REST client.
export function makeShop({ products = [], variations = {}, orders = [], control = controlProduct(), hd = [], failOn = {} } = {}) {
  const all = control ? [control, ...products] : [...products];
  const writes = [];
  const calls = { orders: 0, variations: 0 };
  const find = (id) => all.find((product) => product.id === Number(id));
  const upsertMeta = (target, rows) => {
    for (const row of rows) {
      const existing = target.meta_data.find((meta) => meta.key === row.key);
      if (existing) { existing.value = row.value; } else { target.meta_data.push({ id: 99, ...row }); }
    }
  };

  const wooClient = {
    async listProductsPage({ sku } = {}) {
      if (failOn.control) { throw new Error('woo down'); }
      return all.filter((product) => !sku || product.sku === sku);
    },
    async listAllProducts() {
      if (failOn.products) { throw new Error('woo products down'); }
      return all;
    },
    async getProduct(id) { return find(id); },
    async listVariations(id) {
      calls.variations += 1;
      if (failOn.variations?.includes(id)) { throw new Error(`variations of ${id} down`); }
      return variations[id] || [];
    },
    async listOpenOrdersLite(statuses, options) {
      calls.orders += 1;
      calls.lastOrderQuery = { statuses, ...options };
      if (failOn.orders) { throw new Error('orders down'); }
      const skippedStatuses = statuses.filter((status) => failOn.rejectedStatuses?.includes(status));
      return { orders: orders.filter((order) => statuses.includes(order.status) && !skippedStatuses.includes(order.status)), skippedStatuses };
    },
    async updateProduct(id, fields) {
      writes.push({ kind: 'product', id, fields });
      if (failOn.product?.includes(id)) { throw new Error(`write to ${id} refused`); }
      const target = find(id);
      if (fields.meta_data) { upsertMeta(target, fields.meta_data); }
      if (fields.stock_quantity !== undefined) { Object.assign(target, { stock_quantity: fields.stock_quantity, manage_stock: fields.manage_stock }); }
      return target;
    },
    async batchUpdateVariations(id, updates) {
      writes.push({ kind: 'batch', id, updates });
      if (failOn.batch?.includes(id)) { throw new Error(`batch of ${id} refused`); }
      const answer = [];
      for (const update of updates) {
        if (failOn.variation?.includes(update.id)) { answer.push({ id: update.id, error: { code: 'bad', message: 'refused' } }); continue; }
        const target = variations[id].find((variation) => variation.id === update.id);
        Object.assign(target, { stock_quantity: update.stock_quantity, manage_stock: update.manage_stock });
        upsertMeta(target, update.meta_data || []);
        answer.push({ id: update.id });
      }
      return { update: answer };
    }
  };

  const hdClient = {
    async listWarehouseProducts() {
      if (failOn.hd) { throw new Error('hd down'); }
      return hd;
    }
  };
  return {
    wooClient, hdClient, writes, calls, products: all, variations, orders,
    // Writes that touch stock: everything except the run history on the control product.
    stockWrites: () => writes.filter((write) => !(write.kind === 'product' && write.id === control?.id && write.fields.meta_data?.every((row) => row.key === LINK_META.state))),
    stateWrites: () => writes.filter((write) => write.kind === 'product' && write.id === control?.id),
    controlState: () => JSON.parse(control.meta_data.find((meta) => meta.key === LINK_META.state)?.value || 'null')
  };
}

export function makeService(shop, { config = {}, notify = null, matchingWatch = null, now = NOW, productMap = loadProductMap('woo_product_name,highdelivery_product_name\n') } = {}) {
  const linkIndex = new LinkIndex({ wooClient: shop.wooClient });
  return new StockSyncService({
    wooClient: shop.wooClient, hdClient: shop.hdClient, linkIndex, syncControl: new SyncControl({ wooClient: shop.wooClient }),
    productMap, matchingWatch, notify, config: { ...STOCK_CONFIG, ...config }, logger: quietLogger, now: () => now, sleepImpl: async () => {}
  });
}

// A simple product linked to one HighDelivery item, written by the server.
export const simpleProduct = (id, hdId, { stock = 0, unit = {}, name = `Simple ${id}`, writer = 'server' } = {}) => wooProduct(id, {
  name, stock, manage: true, doc: linkDoc({ p: linkUnit({ writer, items: [{ hd_id: hdId, hd_name: `HD item ${hdId}`, qty: 1 }], ...unit }) })
});

export { canonicalJson, linkDoc, linkUnit, wooProduct, wooVariation };
