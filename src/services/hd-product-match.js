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

function rawQuantity(product) {
  return Number(product?.quantity_available ?? product?.quantityAvailable ?? 0);
}

// "abc", nothing at all, null or an empty string are not quantities (0 and "0" are). Callers that write stock check this first.
export function hasValidQuantity(product) {
  const value = product?.quantity_available ?? product?.quantityAvailable;
  if (value === undefined || value === null || typeof value === 'boolean' || String(value).trim() === '') {
    return false;
  }
  return Number.isFinite(Number(value));
}

// Unreadable counts as 0: an order is then held for a human instead of being sent against stock nobody can read.
export function warehouseQuantity(product) {
  const quantity = rawQuantity(product);
  return Number.isFinite(quantity) ? quantity : 0;
}

// The order lines that name a product and ask for at least one piece.
export function orderLines(lineItems) {
  const lines = [];
  for (const line of Array.isArray(lineItems) ? lineItems : []) {
    const wooName = String(line?.name || '').trim();
    const quantity = Number(line?.quantity || 0);
    if (wooName && quantity > 0) {
      lines.push({ wooName, quantity, productId: line.product_id, variationId: line.variation_id });
    }
  }
  return lines;
}

export function indexByName(warehouseProducts) {
  const byName = new Map();
  for (const product of warehouseProducts || []) {
    byName.set(fold(product?.name), product);
  }
  return byName;
}

// Adds one line's quantity to the warehouse products the order will take (HighDelivery product id -> { product, quantity }).
export function addWanted(wanted, product, quantity) {
  const entry = wanted.get(product.id) || { product, quantity: 0 };
  entry.quantity += quantity;
  wanted.set(product.id, entry);
}

// The name-based way: the line's Woo name -> the CSV's HighDelivery names -> warehouse products.
export function addCsvLine({ wooName, quantity }, { productMap, byName, wanted, problems }) {
  const components = productMap.get(fold(wooName));
  if (!components || components.length === 0) {
    problems.push(`no HighDelivery product is mapped to "${wooName}"`);
    return;
  }
  for (const hdName of components) {
    const product = byName.get(fold(hdName));
    if (!product) {
      problems.push(`"${hdName}" (for "${wooName}") is not in the HighDelivery warehouse`);
      continue;
    }
    addWanted(wanted, product, quantity);
  }
}

// Checks the stock of everything wanted and turns it into the parcel items.
export function finishItems(wanted, problems) {
  const items = [];
  for (const { product, quantity } of wanted.values()) {
    const available = warehouseQuantity(product);
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

// Builds the warehouse items for a parcel from the Woo order lines.
// Returns { ok, items: [{ productId, name, quantity }], problems: [...] }.
// Any line that cannot be matched, or whose stock is too low, is named so the order can stay on-hold for a human.
export function resolveWarehouseItems(lineItems, productMap, warehouseProducts) {
  const byName = indexByName(warehouseProducts);
  const wanted = new Map();
  const problems = [];
  for (const line of orderLines(lineItems)) {
    addCsvLine(line, { productMap, byName, wanted, problems });
  }
  return finishItems(wanted, problems);
}

// "Military Cargo S (x1)" or "Military cap (x2), Military Cargo S (x1)", the way the HighDelivery web app labels a parcel.
export function describeItems(items) {
  return items.map((item) => `${item.name} (x${item.quantity})`).join(', ');
}
