import { addCsvLine, addWanted, finishItems, indexByName, orderLines } from './hd-product-match.js';
import { unitKeyFor } from './product-links.js';

// Which warehouse products does each order line take? A link (by HighDelivery item id) wins; a product without
// a link is resolved by name through the CSV as before. Returns the wanted products without any stock check.
export function resolveOrderLines(lineItems, { unitLookup, csvMap, warehouse }) {
  const byId = new Map((warehouse || []).map((product) => [Number(product.id), product]));
  const byName = indexByName(warehouse);
  const wanted = new Map();
  const problems = [];
  const via = { link: 0, csv: 0 };

  for (const line of orderLines(lineItems)) {
    const found = unitLookup(line.productId, line.variationId);
    if (found.kind === 'none') {
      via.csv += 1;
      addCsvLine(line, { productMap: csvMap, byName, wanted, problems });
    } else if (found.kind === 'unit') {
      via.link += 1;
      addLinkedLine(line, found.unit, { byId, wanted, problems });
    } else if (found.kind === 'ignore') {
      problems.push(`"${line.wooName}" is marked as not a HighDelivery product`);
    } else {
      problems.push(`the link document of "${line.wooName}" cannot be read (${found.error})`);
    }
  }
  return { wanted, problems, via };
}

// For the stock sync's reservations: which HighDelivery items (by id) each open order line still takes.
//   - a linked unit reserves its items by id, also when it is on hold or the item is missing from the warehouse
//     list (reserving too much only under-sells); a hold unit without items takes no known item
//   - a product marked "ignore" is skipped
//   - a product without any link document goes through the CSV; what the CSV cannot place is skipped, because
//     the sync never writes a product without a link
//   - a line the sync cannot place although its product has a link document (an unreadable document, or a size
//     missing from a linked document that the CSV does not place either) is returned in `blocking`, with
//     kind "bad_doc" (its items cannot be known) or "unplaced" (the product's own link document names its items)
//   linkKind(productId) -> 'none' | 'linked' | 'ignore' | 'bad'
// -> { wanted: Map hdId -> quantity, blocking: [{ productId, kind, text }] }
export function resolveReserveLines(lineItems, { unitLookup, linkKind, csvMap, warehouse }) {
  const byName = indexByName(warehouse);
  const wanted = new Map();
  const blocking = [];
  const add = (hdId, quantity) => wanted.set(hdId, (wanted.get(hdId) || 0) + quantity);

  for (const line of orderLines(lineItems)) {
    const found = unitLookup(line.productId, line.variationId);
    if (found.kind === 'unit') {
      for (const item of found.unit.items) {
        add(Number(item.hd_id), line.quantity * item.qty);
      }
    } else if (found.kind === 'bad_doc') {
      blocking.push({ productId: line.productId, kind: 'bad_doc', text: `the link document of "${line.wooName}" cannot be read (${found.error})` });
    } else if (found.kind === 'none') {
      const csvWanted = new Map();
      const csvProblems = [];
      addCsvLine(line, { productMap: csvMap, byName, wanted: csvWanted, problems: csvProblems });
      for (const { product, quantity } of csvWanted.values()) {
        add(Number(product.id), quantity);
      }
      if (csvProblems.length > 0 && linkKind(line.productId) === 'linked') {
        blocking.push({ productId: line.productId, kind: 'unplaced', text: `"${line.wooName}" is not in its product's link document and the CSV does not place it` });
      }
    }
    // kind "ignore": not a HighDelivery product, nothing to reserve
  }
  return { wanted, blocking };
}

function addLinkedLine(line, unit, { byId, wanted, problems }) {
  if (unit.hold) {
    problems.push(`"${line.wooName}" is on hold and cannot be sent automatically`);
    return;
  }
  for (const item of unit.items) {
    const product = byId.get(item.hd_id);
    if (!product) {
      problems.push(`HighDelivery item ${item.hd_id} ("${item.hd_name}") linked to "${line.wooName}" no longer exists`);
      continue;
    }
    addWanted(wanted, product, line.quantity * item.qty);
  }
}

// -> { ok, items: [{ productId, name, quantity }], problems: [], via: { link, csv } }
export function resolveOrderItems(lineItems, context) {
  const { wanted, problems, via } = resolveOrderLines(lineItems, context);
  return { ...finishItems(wanted, problems), via };
}

// Reads the link of every product on the order once, so the resolver itself can stay synchronous.
export async function buildUnitLookup(lineItems, linkIndex) {
  const found = new Map();
  const keyOf = (productId, variationId) => `${productId}:${unitKeyFor(variationId)}`;
  for (const line of orderLines(lineItems)) {
    found.set(keyOf(line.productId, line.variationId), await linkIndex.unitFor(line.productId, line.variationId));
  }
  return (productId, variationId) => found.get(keyOf(productId, variationId));
}

// "30x1,24x2" for the warehouse items an order would take, or "held" when it would not be sent. Ids and counts only.
export function describeResolution(result) {
  return result.ok ? result.items.map((item) => `${item.productId}x${item.quantity}`).sort().join(',') : 'held';
}

export function sameResolution(first, second) {
  return describeResolution(first) === describeResolution(second);
}
