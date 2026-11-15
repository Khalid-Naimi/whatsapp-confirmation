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
// -> { woo: [{ productId, unit, name }], hd: [{ id, name, quantity }], broken: [{ productId, unit, problem }], badDocs: [{ productId, name, error }] }
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
        woo.push(...unitsOf(product, variationsByProduct).filter((unit) => unit.published).map(({ key, name }) => ({ productId: product.id, unit: key, name })));
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
      woo.push(...units.filter((unit) => unit.published && !link.doc.units[unit.key]).map(({ key, name }) => ({ productId: product.id, unit: key, name })));
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
