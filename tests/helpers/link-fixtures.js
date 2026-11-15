import { LINK_META, canonicalJson } from '../../src/services/product-links.js';

export const linkUnit = (over = {}) => ({
  label: '', size: '', items: [{ hd_id: 512, hd_name: 'Zip up Hoodie Saumon XL', qty: 1 }],
  offset: 0, max_online: null, hold: false, sync: true, writer: 'server', ...over
});

export const linkDoc = (units, over = {}) => ({
  schema: 1, rev: 1, updated_at: '2026-11-15T10:00:00Z', updated_by: 'desktop', kind: 'linked', units, ...over
});

export const metaRow = (key, value) => ({ id: 1, key, value: typeof value === 'string' ? value : canonicalJson(value) });

// A WooCommerce product as the REST list returns it.
export function wooProduct(id, { name = `Product ${id}`, type = 'simple', status = 'publish', sku = '', doc = null, docText = null, stock = null, manage = false } = {}) {
  const meta_data = [];
  if (doc || docText !== null) {
    meta_data.push(metaRow(LINK_META.link, docText ?? doc));
  }
  return { id, name, type, status, sku, meta_data, stock_quantity: stock, manage_stock: manage };
}

export const wooVariation = (id, label, { stock = null, manage = true, status = 'publish' } = {}) => ({
  id, status, attributes: [{ id: 1, name: 'Height', option: label }], stock_quantity: stock, manage_stock: manage, meta_data: []
});
