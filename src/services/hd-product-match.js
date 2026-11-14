import fs from 'node:fs';

// Turns a name into a comparable key: no accents, lower case, punctuation and repeated spaces collapsed.
export function fold(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

// Minimal CSV reader: handles quoted fields with commas and doubled quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^﻿/u, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) {
        rows.push(row);
      }
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) {
    rows.push(row);
  }
  return rows;
}

// WooCommerce product (as it appears on the order line) -> the HighDelivery warehouse products it is made of.
// One Woo name can map to several HighDelivery products (a pack); each row of the CSV is one component.
export function loadProductMap(csvText) {
  const [header, ...rows] = parseCsv(csvText);
  const column = (name) => header.findIndex((cell) => cell.trim() === name);
  const wooIndex = column('woo_product_name');
  const hdIndex = column('highdelivery_product_name');
  if (wooIndex < 0 || hdIndex < 0) {
    throw new Error('Product map needs woo_product_name and highdelivery_product_name columns.');
  }
  const map = new Map();
  for (const row of rows) {
    const woo = fold(row[wooIndex]);
    const hd = String(row[hdIndex] || '').trim();
    if (!woo || !hd) {
      continue;
    }
    if (!map.has(woo)) {
      map.set(woo, []);
    }
    map.get(woo).push(hd);
  }
  return map;
}

export function loadProductMapFile(filePath) {
  return loadProductMap(fs.readFileSync(filePath, 'utf8'));
}

// Builds the warehouse items for a parcel from the Woo order lines.
// Returns { ok, items: [{ productId, name, quantity }], problems: [...] }.
// Any line that cannot be matched, or whose stock is too low, is named so the order can stay on-hold for a human.
export function resolveWarehouseItems(lineItems, productMap, warehouseProducts) {
  const byName = new Map();
  for (const product of warehouseProducts || []) {
    byName.set(fold(product?.name), product);
  }

  const wanted = new Map(); // HighDelivery product id -> { product, quantity }
  const problems = [];
  for (const line of Array.isArray(lineItems) ? lineItems : []) {
    const wooName = String(line?.name || '').trim();
    const quantity = Number(line?.quantity || 0);
    if (!wooName || !(quantity > 0)) {
      continue;
    }
    const components = productMap.get(fold(wooName));
    if (!components || components.length === 0) {
      problems.push(`no HighDelivery product is mapped to "${wooName}"`);
      continue;
    }
    for (const hdName of components) {
      const product = byName.get(fold(hdName));
      if (!product) {
        problems.push(`"${hdName}" (for "${wooName}") is not in the HighDelivery warehouse`);
        continue;
      }
      const entry = wanted.get(product.id) || { product, quantity: 0 };
      entry.quantity += quantity;
      wanted.set(product.id, entry);
    }
  }

  const items = [];
  for (const { product, quantity } of wanted.values()) {
    const available = Number(product.quantity_available ?? product.quantityAvailable ?? 0);
    if (available < quantity) {
      problems.push(`not enough "${product.name}" in the HighDelivery warehouse (${available} available, ${quantity} needed)`);
    }
    items.push({ productId: product.id, name: product.name, quantity });
  }
  if (items.length === 0 && problems.length === 0) {
    problems.push('the order has no items');
  }
  return { ok: problems.length === 0, items, problems };
}

// "Military Cargo S (x1)" or "Military cap (x2), Military Cargo S (x1)", the way the HighDelivery web app labels a parcel.
export function describeItems(items) {
  return items.map((item) => `${item.name} (x${item.quantity})`).join(', ');
}
