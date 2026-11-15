import { CONTROL_SKU, LINK_META, parseLinkDoc, readMeta, unitKeyFor } from './product-links.js';

const NO_LINK = Object.freeze({ kind: 'none' });

// What a product's link document says about one order line or stock unit:
//   none     - no document, or the unit is not in it: the caller falls back to the CSV
//   unit     - a link; `unit` is the document entry
//   ignore   - the owner marked the product "not a HighDelivery product"
//   bad_doc  - a document exists but cannot be read; `error` says why (never guessed around)
function lookupIn(entry, variationId) {
  const { link } = entry;
  if (link.error === 'missing') {
    return NO_LINK;
  }
  if (!link.ok) {
    return { kind: 'bad_doc', error: link.error };
  }
  if (link.doc.kind === 'ignore') {
    return { kind: 'ignore' };
  }
  const unit = link.doc.units[unitKeyFor(variationId)];
  return unit ? { kind: 'unit', unit } : NO_LINK;
}

// All link documents of the shop, read from the products' meta. Shared by the order routing and the stock sync.
export class LinkIndex {
  constructor({ wooClient, ttlMs = 10 * 60 * 1000, now = () => Date.now() }) {
    this.wooClient = wooClient;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  // Replaces everything with one fresh read of the product list.
  async load() {
    const products = await this.wooClient.listAllProducts();
    this.entries = new Map(products.filter((product) => product.sku !== CONTROL_SKU).map((product) => [String(product.id), this.entryFor(product)]));
  }

  entryFor(product) {
    return { product, link: parseLinkDoc(readMeta(product, LINK_META.link)), readAt: this.now() };
  }

  // Cached; a product that is unknown or older than the time limit is re-read on its own, so a link saved
  // a moment ago is picked up without reading the whole shop.
  async unitFor(productId, variationId) {
    if (!(Number(productId) > 0)) {
      return NO_LINK;
    }
    const key = String(productId);
    let entry = this.entries.get(key);
    if (!entry || this.now() - entry.readAt > this.ttlMs) {
      entry = this.entryFor(await this.wooClient.getProduct(key));
      this.entries.set(key, entry);
    }
    return lookupIn(entry, variationId);
  }

  // Same answer from what is already loaded, without any call.
  lookup(productId, variationId) {
    const entry = this.entries.get(String(productId));
    return entry ? lookupIn(entry, variationId) : NO_LINK;
  }

  // [{ product, link }] for every product of the last load.
  products() {
    return [...this.entries.values()];
  }
}
