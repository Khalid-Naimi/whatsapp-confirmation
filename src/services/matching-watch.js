import { CONTROL_SKU } from './product-links.js';

const variationName = (product, variation) => {
  const options = (variation.attributes || []).map((attribute) => attribute.option).filter(Boolean).join(' / ');
  return options ? `${product.name} - ${options}` : product.name;
};

// Which shop products and HighDelivery items have no link yet? Pure: works on what the stock sync already loaded.
//   products            [{ product, link }] from the LinkIndex
//   variationsByProduct Map productId -> variations (only for variable products that were read)
//   warehouse           the HighDelivery rows
//   control             the parsed control record, or null
// -> { woo: [{ productId, unit, name, productName }], hd: [{ id, name, quantity }], broken: [{ productId, unit, problem }], badDocs: [{ productId, name, error }] }
export function findUnlinked({ products, variationsByProduct, warehouse, control }) {
  const woo = [];
  const broken = [];
  const badDocs = [];
  const referenced = new Set();

  for (const { product, link } of products) {
    if (product.sku === CONTROL_SKU) {
      continue;
    }
    const published = product.status === 'publish';
    if (!link.ok) {
      if (link.error !== 'missing') {
        badDocs.push({ productId: product.id, name: product.name, error: link.error });
      } else if (published) {
        woo.push(...unitsOf(product, variationsByProduct).filter((unit) => unit.published).map(({ key, name }) => ({ productId: product.id, unit: key, name, productName: product.name })));
      }
      continue;
    }
    for (const unit of Object.values(link.doc.units)) {
      unit.items.forEach((item) => referenced.add(item.hd_id));
    }
    if (link.doc.kind === 'ignore') {
      continue;
    }
    const units = unitsOf(product, variationsByProduct);
    const known = new Set(units.map((unit) => unit.key));
    if (published) {
      woo.push(...units.filter((unit) => unit.published && !link.doc.units[unit.key]).map(({ key, name }) => ({ productId: product.id, unit: key, name, productName: product.name })));
    }
    if (variationsKnown(product, variationsByProduct)) {
      for (const key of Object.keys(link.doc.units).filter((unitKey) => !known.has(unitKey))) {
        broken.push({ productId: product.id, unit: key, problem: 'variation_missing' });
      }
    }
  }

  const ignored = new Set(control?.ignored_hd_ids || []);
  const hd = warehouse
    .filter((row) => !referenced.has(Number(row.id)) && !ignored.has(Number(row.id)))
    .map((row) => ({ id: row.id, name: String(row.name ?? ''), quantity: Number(row.quantity_available ?? row.quantityAvailable ?? 0) }));
  return { woo, hd, broken, badDocs };
}

const variationsKnown = (product, variationsByProduct) => product.type !== 'variable' || variationsByProduct.has(product.id);

// The stock units of a product: one for a simple product, one per variation for a variable one (none when the
// variations could not be read).
function unitsOf(product, variationsByProduct) {
  if (product.type !== 'variable') {
    return [{ key: 'p', name: product.name, published: true }];
  }
  return (variationsByProduct.get(product.id) || []).map((variation) => ({
    key: String(variation.id),
    name: variationName(product, variation),
    published: variation.status === 'publish'
  }));
}

const REALERT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAMES = 5;

const clean = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60);
const wooKey = (row) => (row.unit === 'p' ? String(row.productId) : row.unit);

function listNames(names) {
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} (+${names.length - MAX_NAMES} autres)` : shown;
}

// The WhatsApp text for the team: product names only, never anything about a customer.
export function buildDigest({ woo, hd }) {
  const products = new Map();
  for (const row of woo) {
    const known = products.get(row.productId) || { name: clean(row.productName), sizes: 0, variable: false };
    known.sizes += 1;
    known.variable = known.variable || row.unit !== 'p';
    products.set(row.productId, known);
  }
  const total = products.size + hd.length;
  const parts = [`Rhymat: ${total} ${total === 1 ? 'nouveau produit a relier' : 'nouveaux produits a relier'}.`];
  if (products.size) {
    parts.push(`Woo: ${listNames([...products.values()].map((p) => (p.variable ? `${p.name} (${p.sizes} ${p.sizes === 1 ? 'taille' : 'tailles'})` : p.name)))}.`);
  }
  if (hd.length) {
    parts.push(`HD: ${listNames(hd.map((row) => clean(row.name)))}.`);
  }
  parts.push("Ouvrir Matching dans l'app.");
  return parts.join(' ');
}

// One digest to the team when products or HighDelivery items appear that have no link. Off unless enabled.
// What was told is kept in `alerted` (saved with the sync state), so a restart does not repeat it; an item still
// unlinked after seven days is mentioned again.
export class MatchingWatch {
  constructor({ notify, enabled = false, logger = console, now = () => new Date() }) {
    this.notify = notify;
    this.enabled = Boolean(enabled);
    this.logger = logger;
    this.now = now;
  }

  // -> the new `alerted` value ({ woo: { key: iso }, hd: { id: iso } }), without marks of items that are linked by now.
  async alertNew({ unlinked, alerted }) {
    if (!this.enabled || !this.notify) {
      return alerted;
    }
    const at = this.now();
    const due = (mark) => !mark || at.getTime() - Date.parse(mark) >= REALERT_AFTER_MS;
    const fresh = {
      woo: unlinked.woo.filter((row) => due(alerted.woo[wooKey(row)])),
      hd: unlinked.hd.filter((row) => due(alerted.hd[String(row.id)]))
    };
    const next = {
      woo: Object.fromEntries(unlinked.woo.map(wooKey).filter((key) => alerted.woo[key]).map((key) => [key, alerted.woo[key]])),
      hd: Object.fromEntries(unlinked.hd.map((row) => String(row.id)).filter((key) => alerted.hd[key]).map((key) => [key, alerted.hd[key]]))
    };
    if (fresh.woo.length === 0 && fresh.hd.length === 0) {
      return next;
    }
    const sent = await this.notify(buildDigest(fresh));
    if (!sent) {
      this.logger.warn('[matching-watch] the digest reached nobody; it will be tried again at the next run');
      return next;
    }
    fresh.woo.forEach((row) => { next.woo[wooKey(row)] = at.toISOString(); });
    fresh.hd.forEach((row) => { next.hd[String(row.id)] = at.toISOString(); });
    return next;
  }
}
