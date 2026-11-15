import { createHash } from 'node:crypto';
import { HD_META } from './hd-auto-send-service.js';
import { hasValidQuantity, warehouseQuantity } from './hd-product-match.js';
import { findUnlinked } from './matching-watch.js';
import { resolveReserveLines } from './order-resolver.js';
import { LINK_META, canonicalJson, readMeta } from './product-links.js';

const MAX_VARIATION_ERRORS = 3;
const MAX_RUNS = 24;
const MAX_LISTED_CHANGES = 50;
const MAX_BATCH_SIZE = 100;
const MAX_MISSING_HD_SHARE = 0.2;
const ABORT_ALERT_GAP_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_ORDER_DAYS = 30;
const MAX_VANISHED_LOOKUPS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// Pure part: no calls, no clock.
// ---------------------------------------------------------------------------------------------------------------

// What the shop may show online for one unit. The desktop app uses the same formula and the same fixture.
//   hold: forced to 0. Otherwise the HighDelivery quantity minus what open orders still need (counted in
//   HighDelivery units, item qty included), minus the offset kept back, never below 0, divided by the item's qty
//   (one shop piece takes qty HighDelivery pieces) and rounded down, and never above the cap (max_online).
export function computeTarget(hdQty, reserved, unit) {
  if (unit.hold) {
    return 0;
  }
  const pieces = Math.floor(Math.max(0, hdQty - reserved - unit.offset) / unit.items[0].qty);
  return unit.max_online === null ? pieces : Math.min(pieces, unit.max_online);
}

// Units of each HighDelivery item that open orders will still take: Map hdId -> quantity.
// An order that is already at HighDelivery (state "sent") has been taken out of the HighDelivery stock; every
// other open order counts, including "sending" and "unknown" (counting an order twice only under-sells).
//   resolveLines(lineItems) -> [{ hdId, quantity }]
//   resolveLines(lineItems, order) -> [{ hdId, quantity }]
export function computeReservations(orders, resolveLines) {
  const reserved = new Map();
  for (const order of orders) {
    if (readMeta(order, HD_META.state) === 'sent') {
      continue;
    }
    for (const { hdId, quantity } of resolveLines(order.line_items, order)) {
      reserved.set(hdId, (reserved.get(hdId) || 0) + quantity);
    }
  }
  return reserved;
}

// Backorders let customers buy more than the stock shows; a unit this sync writes must not allow them.
// A product or variation read without the field counts as not allowing them (every write still sends "no").
export function stockOf(entity) {
  const managed = entity.manage_stock === true;
  return {
    managed,
    parentManaged: entity.manage_stock === 'parent',
    current: managed && Number.isInteger(entity.stock_quantity) ? entity.stock_quantity : null,
    backordersOff: entity.backorders === undefined || entity.backorders === null || entity.backorders === 'no'
  };
}

// The stock now in the shop for a unit, or null when the unit does not exist (or its variations were not read).
// A grouped, external or other product type has no stock of its own: { unsupported: true }.
function currentStock(product, key, variations) {
  if (product.type === 'variable') {
    const variation = key === 'p' ? null : (variations || []).find((candidate) => String(candidate.id) === key);
    return variation ? stockOf(variation) : null;
  }
  if (key !== 'p') {
    return null;
  }
  return product.type === 'simple' ? stockOf(product) : { unsupported: true };
}

function explain({ hd, reserved, unit, target }) {
  if (unit.hold) {
    return 'on hold: online stock is 0';
  }
  const pool = Math.max(0, hd - reserved - unit.offset);
  const qty = unit.items[0].qty;
  const text = `hd ${hd} - reserved ${reserved} - offset ${unit.offset} = ${pool}${qty > 1 ? ` / ${qty} per piece = ${Math.floor(pool / qty)}` : ''}`;
  return unit.max_online !== null && target === unit.max_online ? `${text}, capped at ${unit.max_online}` : text;
}

function rowFor(product, key, unit) {
  const item = unit.items[0];
  return {
    productId: product.id, unit: key, label: unit.label, hdId: item ? item.hd_id : null, hdName: item ? item.hd_name : '',
    hd: null, reserved: 0, offset: unit.offset, cap: unit.max_online, hold: unit.hold, writer: unit.writer, current: null, target: null, action: '', why: ''
  };
}

// One row per unit of every readable link document. Only units with writer "server" and sync on get a target.
//   products             [{ product, link }] from the LinkIndex
//   variationsByProduct  Map productId -> variations
//   warehouse            HighDelivery rows
//   reservations         Map hdId -> quantity
//   preview              true on a run that cannot write: units the desktop app writes also get a number, as
//                        "preview_write" / "preview_same" rows, which no write path ever picks up
//   unresolvedProducts   ids of products with an open order line that cannot be placed (see skipUnresolved)
//
// write / same, or preview_write / preview_same. Stock that is not managed always needs a write (the write sets
// manage_stock true and backorders "no"). A unit written here whose stock is already right but which allows
// backorders gets "backorders_fix": only backorders "no" is written, outside the size limits and the plan hash.
function actionFor(target, info) {
  const same = info.managed && info.current === target;
  if (info.previewOnly) {
    return same ? 'preview_same' : 'preview_write';
  }
  if (same) {
    return info.backordersOff ? 'same' : 'backorders_fix';
  }
  return 'write';
}

function backordersNote(row, info) {
  if (info.backordersOff || info.previewOnly) {
    return '';
  }
  return row.action === 'write' ? ', backorders turned off' : (row.action === 'backorders_fix' ? ', stock already right, only backorders turned off' : '');
}

// Units this run gives a number to and writes (or leaves as they are): they share their item's pool.
const PLANNED = ['write', 'same', 'backorders_fix'];

function planUnit(product, key, unit, { variationsByProduct, hdById, reservations, preview, sharers }) {
  const row = rowFor(product, key, unit);
  const skip = (action, why) => ({ ...row, action, why });
  const previewOnly = unit.writer !== 'server';
  if (previewOnly && !preview) {
    return skip('skip_writer_desktop', 'the desktop app writes this unit');
  }
  if (!unit.sync) {
    return skip('skip_no_sync', 'sync is off for this unit');
  }
  if (unit.items.length > 1) {
    return skip('skip_bundle', 'bundles are not written');
  }
  const stock = currentStock(product, key, variationsByProduct.get(product.id));
  if (!stock) {
    return null; // a missing variation is reported as a broken link, not planned
  }
  if (stock.unsupported) {
    return skip('skip_product_type', `a ${product.type || 'product'} of this type has no stock of its own`);
  }
  if (stock.parentManaged) {
    return skip('skip_parent_stock', 'the stock of this variation is managed on the parent product');
  }
  const base = { ...row, current: stock.current };
  const info = { ...stock, previewOnly };
  const finish = (target, hd, reserved) => {
    const filled = { ...base, hd, reserved, target, action: actionFor(target, info) };
    return { ...filled, why: explain({ hd, reserved, unit, target }) + backordersNote(filled, info) };
  };
  if (unit.hold) {
    return finish(0, null, 0);
  }
  const hdRow = hdById.get(unit.items[0].hd_id);
  if (!hdRow) {
    return { ...base, action: 'skip_hd_missing', why: `HighDelivery item ${unit.items[0].hd_id} was not in the list` };
  }
  if (!hasValidQuantity(hdRow)) {
    return { ...base, action: 'skip_hd_bad', why: `HighDelivery item ${unit.items[0].hd_id} has an unreadable quantity` };
  }
  const hd = warehouseQuantity(hdRow);
  const reserved = reservations.get(unit.items[0].hd_id) || 0;
  const planned = finish(computeTarget(hd, reserved, unit), hd, reserved);
  if (!previewOnly) {
    sharers.push({ row: planned, info, qty: unit.items[0].qty, offset: unit.offset });
  }
  return planned;
}

const unitOrder = (a, b) => (a.productId - b.productId) || (a.unit === b.unit ? 0 : a.unit === 'p' ? -1 : b.unit === 'p' ? 1 : Number(a.unit) - Number(b.unit));

// HighDelivery pieces the shop already shows through units this run does not write (written by the desktop app,
// sync off, bundles, held or parent-managed units that are not written here): Map hdId -> pieces.
// Only stock that is known counts: a managed whole number above 0 (for a parent-managed variation, the parent's
// stock, once per product and item).
function shownElsewhere(products, variationsByProduct, writtenHere) {
  const shown = new Map();
  const parentCounted = new Set();
  for (const { product, link } of products) {
    if (!link.ok || link.doc.kind !== 'linked') {
      continue;
    }
    for (const [key, unit] of Object.entries(link.doc.units)) {
      if (writtenHere.has(`${product.id}|${key}`) || unit.items.length === 0) {
        continue;
      }
      const stock = currentStock(product, key, variationsByProduct.get(product.id));
      if (!stock || stock.unsupported) {
        continue;
      }
      for (const item of unit.items) {
        let pieces = 0;
        if (stock.parentManaged) {
          const parent = stockOf(product);
          const mark = `${product.id}|${item.hd_id}`;
          if (!parentCounted.has(mark) && parent.current > 0) {
            parentCounted.add(mark);
            pieces = parent.current;
          }
        } else if (stock.current > 0) {
          pieces = stock.current;
        }
        if (pieces > 0) {
          shown.set(item.hd_id, (shown.get(item.hd_id) || 0) + pieces * item.qty);
        }
      }
    }
  }
  return shown;
}

// Several units this run writes may read the same HighDelivery item (two sizes on one item, or one item on two
// products). Each unit's own target is worked out from the whole item, so together they could show more than
// HighDelivery has. Here the units of one item share what is really free:
//   free = HD - reserved - the largest offset of those units - what other units already show of the item
// handed out one piece at a time, in a fixed order (product id, then "p", then variation id), never above a
// unit's own target. A unit alone on its item with nothing shown elsewhere keeps exactly its own target.
function shareHdPools(sharers, shown) {
  const byItem = new Map();
  for (const sharer of sharers) {
    byItem.set(sharer.row.hdId, [...(byItem.get(sharer.row.hdId) || []), sharer]);
  }
  for (const [hdId, group] of byItem) {
    const others = shown.get(hdId) || 0;
    if (group.length === 1 && others === 0) {
      continue;
    }
    const { hd, reserved } = group[0].row;
    const offset = Math.max(...group.map((sharer) => sharer.offset));
    const free = Math.max(0, hd - reserved - offset - others);
    const ordered = [...group].sort((a, b) => unitOrder(a.row, b.row));
    const given = new Map(ordered.map((sharer) => [sharer, 0]));
    let left = free;
    for (let progress = true; progress;) {
      progress = false;
      for (const sharer of ordered) {
        if (given.get(sharer) < sharer.row.target && sharer.qty <= left) {
          given.set(sharer, given.get(sharer) + 1);
          left -= sharer.qty;
          progress = true;
        }
      }
    }
    for (const sharer of ordered) {
      const { row, info } = sharer;
      const own = row.target;
      row.target = given.get(sharer);
      row.action = actionFor(row.target, info);
      const base = row.why.replace(/, (stock already right, only )?backorders turned off$/u, '');
      const elsewhere = others > 0 ? ` after ${others} shown by other units` : '';
      row.why = `${base}; item ${hdId} is shared: ${free} free for ${group.length} unit${group.length > 1 ? 's' : ''} written here${elsewhere}, this unit gets ${row.target}${row.target < own ? ` (alone it would get ${own})` : ''}${backordersNote(row, info)}`;
    }
  }
}

// An open order line that cannot be placed (a size missing from a linked document and not in the CSV) takes an
// unknown HighDelivery item, so its reservation is unknown. The units of that product, and every unit sharing a
// HighDelivery item with them, are not written this run ("skip_orders_unresolved"); everything else goes on.
function skipUnresolved(rows, products, unresolvedProducts) {
  const blocked = new Set([...unresolvedProducts].map(Number));
  if (blocked.size === 0) {
    return;
  }
  const items = new Set();
  for (const { product, link } of products) {
    if (blocked.has(Number(product.id)) && link.ok && link.doc.kind === 'linked') {
      Object.values(link.doc.units).forEach((unit) => unit.items.forEach((item) => items.add(item.hd_id)));
    }
  }
  for (const row of rows) {
    if (!PLANNED.includes(row.action)) {
      continue;
    }
    if (blocked.has(Number(row.productId))) {
      Object.assign(row, { action: 'skip_orders_unresolved', why: 'an open order of this product cannot be matched to a HighDelivery item; not written until the link is fixed or the order is closed' });
    } else if (items.has(row.hdId)) {
      Object.assign(row, { action: 'skip_orders_unresolved', why: `HighDelivery item ${row.hdId} is shared with a product whose open order cannot be matched; not written until that is fixed` });
    }
  }
}

export function computeStockPlan({ products, variationsByProduct, warehouse, reservations, preview = false, unresolvedProducts = [] }) {
  const hdById = new Map(warehouse.map((row) => [Number(row.id), row]));
  const sharers = [];
  const context = { variationsByProduct, hdById, reservations, preview, sharers };
  const rows = [];
  for (const { product, link } of products) {
    if (!link.ok) {
      if (link.error !== 'missing') {
        rows.push({ ...rowFor(product, '', { items: [], label: '', offset: 0, max_online: null, hold: false }), action: 'skip_bad_doc', why: `${link.error} ${link.detail || ''}`.trim() });
      }
      continue;
    }
    if (link.doc.kind !== 'linked') {
      continue;
    }
    for (const [key, unit] of Object.entries(link.doc.units)) {
      const row = planUnit(product, key, unit, context);
      if (row) {
        rows.push(row);
      }
    }
  }
  // Units written here: they share the item's pool. Held units written here go to 0 and take nothing.
  const writtenHere = new Set(rows.filter((row) => PLANNED.includes(row.action)).map((row) => `${row.productId}|${row.unit}`));
  shareHdPools(sharers, shownElsewhere(products, variationsByProduct, writtenHere));
  skipUnresolved(rows, products, unresolvedProducts);
  return rows;
}

const writesOf = (plan) => plan.filter((row) => row.action === 'write');
const backorderFixesOf = (plan) => plan.filter((row) => row.action === 'backorders_fix');
const increaseOf = (row) => row.target - (row.current ?? 0);

// Same inputs -> same hash, whatever the order of the rows. An approval is only valid for this exact set of writes.
export function planHash(plan) {
  const lines = writesOf(plan).map((row) => `${row.productId}|${row.unit}|${row.current ?? ''}|${row.target}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// The checks that stop a whole run. -> { ok, reason, detail, approvable }
// approvable: only the size limits can be approved by the owner; a doubtful HighDelivery answer never can.
export function checkGuards(plan, { warehouse, limits }) {
  const failures = [];
  const fail = (reason, detail, approvable) => failures.push({ reason, detail, approvable });

  const total = warehouse.reduce((sum, row) => sum + Math.max(0, warehouseQuantity(row)), 0);
  if (warehouse.length === 0) {
    fail('hd_empty', 'HighDelivery returned no items', false);
  } else if (total === 0) {
    fail('hd_total_zero', 'HighDelivery reports zero stock for every item', false);
  } else if (warehouse.length < limits.minHdItems) {
    fail('hd_too_few_items', `HighDelivery returned only ${warehouse.length} items (at least ${limits.minHdItems} expected)`, false);
  }
  const unreadable = (row) => row.action === 'skip_hd_missing' || row.action === 'skip_hd_bad';
  // Only units this server writes count here, so a test run (which also shows desktop-written units) is stopped
  // by exactly the checks a live run would be.
  const mine = plan.filter((row) => row.writer !== 'desktop');
  const linkedIds = new Set(mine.filter((row) => row.hdId !== null && (PLANNED.includes(row.action) || unreadable(row))).map((row) => row.hdId));
  const missingIds = new Set(mine.filter(unreadable).map((row) => row.hdId));
  if (linkedIds.size > 0 && missingIds.size / linkedIds.size > MAX_MISSING_HD_SHARE) {
    fail('hd_ids_missing', `${missingIds.size} of ${linkedIds.size} linked HighDelivery items are missing or unreadable in its list`, false);
  }
  if (plan.some((row) => row.action === 'write' && !(Number.isInteger(row.target) && row.target >= 0))) {
    fail('bad_target', 'a planned stock value is not a whole number of 0 or more', false);
  }

  const writes = writesOf(plan);
  if (writes.length > limits.maxChangedUnits) {
    fail('too_many_changes', `${writes.length} units would change (limit ${limits.maxChangedUnits})`, true);
  }
  const delta = writes.reduce((sum, row) => sum + Math.abs(increaseOf(row)), 0);
  if (delta > limits.maxTotalDelta) {
    fail('too_much_delta', `the stock would move by ${delta} units in total (limit ${limits.maxTotalDelta})`, true);
  }
  // A unit going from 0 to more triggers the customers' back-in-stock WhatsApp alerts.
  const restocks = writes.filter((row) => (row.current ?? 0) <= 0 && row.target > 0).length;
  if (restocks > limits.maxRestocks) {
    fail('too_many_restocks', `${restocks} sold-out units would come back in stock (limit ${limits.maxRestocks})`, true);
  }
  if (writes.some((row) => increaseOf(row) > limits.maxSingleIncrease)) {
    fail('single_increase_too_big', `one unit would rise by more than ${limits.maxSingleIncrease}`, true);
  }

  const first = failures.find((failure) => !failure.approvable) || failures[0];
  return first ? { ok: false, reason: first.reason, detail: first.detail, approvable: first.approvable } : { ok: true, reason: '', detail: '', approvable: false };
}

// env mode + the pause switch -> what the run may do. A control record that cannot be read counts as paused.
//   live only when STOCK_SYNC_MODE=live and the record is readable and not paused; otherwise a run only computes.
export function describeMode(envMode, controlRead) {
  const paused = !controlRead.ok || controlRead.control.paused;
  const effective = envMode === 'off' ? 'off' : (envMode === 'live' && !paused ? 'live' : 'dry_run');
  return { env: envMode, paused, effective, controlProblem: controlRead.ok ? '' : controlRead.error };
}

function chunk(rows, size) {
  const parts = [];
  for (let start = 0; start < rows.length; start += size) {
    parts.push(rows.slice(start, start + size));
  }
  return parts;
}

// Why a read or write failed, short and without addresses.
function shortReason(error) {
  return String(error?.message || error || 'error').replace(/https?:\/\/\S+/gu, '').replace(/["\\]/gu, "'").trim().slice(0, 120);
}

class SyncAbort extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The hourly stock sync.
// ---------------------------------------------------------------------------------------------------------------

export class StockSyncService {
  // `alert` (services/alerts.js alert({ key, text, windowMs })) is the one team alert path; without it the plain
  // `notify(text)` is used as before.
  constructor({ wooClient, hdClient, linkIndex, syncControl, productMap, matchingWatch = null, notify = null, alert = null, config, logger = console, now = () => new Date(), sleepImpl = sleep }) {
    this.wooClient = wooClient;
    this.hdClient = hdClient;
    this.linkIndex = linkIndex;
    this.syncControl = syncControl;
    this.productMap = productMap;
    this.matchingWatch = matchingWatch;
    this.notify = notify;
    this.alert = alert;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.sleep = sleepImpl;
    this.running = false;
    // The promise of the run in progress (null when idle), so a shutdown can wait for it.
    this.runPromise = null;
    this.last = null; // { summary, plan, unlinked, mode, approvable } of the last run since this process started
    this.lastMode = null;
  }

  // Runs one sync. Never throws for an expected problem: it aborts and says why in the summary.
  //   dryRun: compute and report only. approveHash: apply a plan that was stopped only by a size limit, once,
  //   if the freshly computed plan is exactly the one the owner looked at.
  async run({ dryRun = false, approveHash = '' } = {}) {
    if (this.running) {
      return { skipped: 'already_running' };
    }
    if (this.config.mode === 'off' && !dryRun) {
      return { skipped: 'off', mode: { env: 'off', paused: null, effective: 'off', controlProblem: '' } };
    }
    this.running = true;
    const promise = this.execute({ dryRun, approveHash });
    this.runPromise = promise.catch(() => {});
    try {
      return await promise;
    } finally {
      this.running = false;
      this.runPromise = null;
    }
  }

  // One team message through the alert path when there is one (deduplicated by key), else straight through notify.
  // -> how many got it (0 when deduplicated).
  async teamAlert({ key, text, windowMs }) {
    if (this.alert) {
      const outcome = await this.alert({ key, text, windowMs });
      return outcome?.delivered ? Math.max(1, outcome.sent || 0) : 0;
    }
    return this.notify(text);
  }

  async execute({ dryRun, approveHash }) {
    const at = this.now();
    const controlRead = await this.syncControl.read();
    const mode = describeMode(this.config.mode, controlRead);
    this.lastMode = mode;
    const writesAllowed = !dryRun && mode.effective === 'live';
    const outcome = { at, mode, runMode: writesAllowed ? 'live' : 'dry_run', controlRead, plan: [], unlinked: null, errors: 0, skippedStatuses: [], written: [], skippedChanged: [], aborted: '', abortDetail: '', approvable: false, approval: '', unresolved: [], oldReserving: 0, replanned: false, backordersFixed: [] };

    try {
      await this.compute(outcome);
      this.decide(outcome, { writesAllowed, approveHash });
      if (outcome.apply && await this.recheckBeforeWriting(outcome, { mayReplan: true }) === 'replan') {
        // Only orders that went to HighDelivery moved: their pieces have left the warehouse, so plan once more.
        Object.assign(outcome, { plan: [], errors: 0, aborted: '', abortDetail: '', approvable: false, approval: '', replanned: true });
        await this.compute(outcome);
        this.decide(outcome, { writesAllowed, approveHash });
        if (outcome.apply) {
          await this.recheckBeforeWriting(outcome, { mayReplan: false });
        }
      }
      if (outcome.apply) {
        await this.applyWrites(outcome);
      }
      if (writesAllowed && (!outcome.aborted || outcome.approvable)) {
        await this.applyBackorderFixes(outcome);
      }
    } catch (error) {
      // An unexpected error is an abort like any other: the run is recorded and the team is told.
      outcome.aborted = error instanceof SyncAbort ? error.reason : 'internal_error';
      outcome.abortDetail = shortReason(error instanceof SyncAbort ? error.message : error);
      if (!(error instanceof SyncAbort)) {
        this.logger.warn(`[stock-sync] internal error: ${outcome.abortDetail}`);
      }
    }
    return this.finish(outcome);
  }

  async step(reason, work) {
    try {
      return await work();
    } catch (error) {
      throw new SyncAbort(reason, shortReason(error));
    }
  }

  // Reads everything and fills outcome.plan, planHash, unlinked and the guard result.
  async compute(outcome) {
    await this.step('woo_products_failed', () => this.linkIndex.load());
    const products = this.linkIndex.products();
    outcome.productsById = new Map(products.map(({ product }) => [product.id, product]));
    // Open orders first, then HighDelivery (never from its cache): an order sent to HighDelivery in between is then
    // both still reserved and already gone from the warehouse, which only under-sells.
    const orders = await this.readOpenOrders(outcome);
    const warehouse = await this.step('hd_unavailable', () => this.hdClient.listWarehouseProducts({ fresh: true }));
    outcome.warehouse = warehouse;
    const { reservations, unresolved, oldReserving } = this.reserve(orders, warehouse);
    Object.assign(outcome, { orders, unresolved, oldReserving });
    const variationsByProduct = await this.readVariations(products, outcome);
    const unresolvedProducts = unresolved.map((line) => line.productId);
    outcome.plan = computeStockPlan({ products, variationsByProduct, warehouse, reservations, preview: outcome.runMode !== 'live', unresolvedProducts });
    outcome.hash = planHash(outcome.plan);
    outcome.guards = checkGuards(outcome.plan, { warehouse, limits: this.config });
    outcome.unlinked = findUnlinked({ products, variationsByProduct, warehouse, control: outcome.controlRead.control });
  }

  // Every open order in the reserve statuses made in the last reserveDays. If the shop rejected one of the
  // configured statuses, its orders are missing from the list and the numbers would be too high: the run stops.
  async readOpenOrders(outcome) {
    const after = new Date(this.now().getTime() - this.config.reserveDays * DAY_MS).toISOString();
    const { orders, skippedStatuses } = await this.step('orders_failed', () => this.wooClient.listOpenOrdersLite(this.config.reserveStatuses, { after }));
    outcome.skippedStatuses = skippedStatuses;
    if (skippedStatuses.length > 0) {
      throw new SyncAbort('reserve_status_rejected', `the shop does not know the order status ${skippedStatuses.join(', ')}, so those orders cannot be reserved`);
    }
    return orders;
  }

  // Units of each HighDelivery item that open orders still need. -> { reservations, unresolved, oldReserving }
  //   unresolved    lines of linked products whose size cannot be placed: those products (and every unit sharing
  //                 an item with them) are skipped by the plan
  //   oldReserving  orders older than 30 days that still reserve something (shown in the run summary)
  // A line of a product whose link document cannot be read stops the run: its items, and so the units that would
  // have to be skipped, cannot be known.
  reserve(orders, warehouse) {
    const links = new Map(this.linkIndex.products().map(({ product, link }) => [String(product.id), link]));
    const linkKind = (productId) => {
      const link = links.get(String(productId));
      if (!link || link.error === 'missing') {
        return 'none';
      }
      return link.ok ? link.doc.kind : 'bad';
    };
    const context = { unitLookup: (productId, variationId) => this.linkIndex.lookup(productId, variationId), linkKind, csvMap: this.productMap, warehouse };
    const blocking = [];
    const oldBefore = this.now().getTime() - OLD_ORDER_DAYS * DAY_MS;
    let oldReserving = 0;
    const reservations = computeReservations(orders, (lineItems, order) => {
      const result = resolveReserveLines(lineItems, context);
      blocking.push(...result.blocking.map((line) => ({ ...line, orderId: order.id, text: `order ${order.id}: ${line.text}` })));
      const made = Date.parse(/[zZ]|[+-]\d\d:\d\d$/u.test(String(order.date_created_gmt || '')) ? order.date_created_gmt : `${order.date_created_gmt}Z`);
      if (result.wanted.size > 0 && made < oldBefore) {
        oldReserving += 1;
      }
      return [...result.wanted].map(([hdId, quantity]) => ({ hdId, quantity }));
    });
    const unreadable = blocking.filter((line) => line.kind === 'bad_doc');
    if (unreadable.length > 0) {
      throw new SyncAbort('orders_unresolved', `${unreadable[0].text}${unreadable.length > 1 ? ` (+${unreadable.length - 1} more open order lines)` : ''}`);
    }
    return { reservations, unresolved: blocking, oldReserving };
  }

  // The variation lists of the variable products that matter. One failing product is skipped; more than three stop the run.
  async readVariations(products, outcome) {
    const variationsByProduct = new Map();
    for (const { product, link } of products) {
      if (!this.needsVariations(product, link)) {
        continue;
      }
      try {
        variationsByProduct.set(product.id, await this.wooClient.listVariations(product.id));
      } catch (error) {
        outcome.errors += 1;
        this.logger.warn(`[stock-sync] could not read the variations of product ${product.id}: ${shortReason(error)}`);
      }
    }
    if (outcome.errors > MAX_VARIATION_ERRORS) {
      throw new SyncAbort('variations_failed', `${outcome.errors} products could not be read`);
    }
    return variationsByProduct;
  }

  needsVariations(product, link) {
    if (product.type !== 'variable' || (link.ok && link.doc.kind === 'ignore')) {
      return false;
    }
    const writesIt = link.ok && Object.values(link.doc.units).some((unit) => unit.writer === 'server' && unit.sync);
    return product.status === 'publish' || writesIt;
  }

  // Do the guards stop this run, and may an approval lift that?
  decide(outcome, { writesAllowed, approveHash }) {
    const { guards, hash } = outcome;
    outcome.apply = writesAllowed && guards.ok;
    if (guards.ok) {
      return;
    }
    outcome.aborted = guards.reason;
    outcome.abortDetail = guards.detail;
    outcome.approvable = guards.approvable;
    if (!approveHash) {
      return;
    }
    if (!guards.approvable) {
      outcome.approval = 'not_approvable';
    } else if (approveHash !== hash) {
      outcome.approval = 'hash_mismatch';
    } else if (!writesAllowed) {
      outcome.approval = 'not_live';
    } else {
      outcome.approval = 'applied';
      outcome.apply = true;
      outcome.aborted = '';
      outcome.abortDetail = '';
    }
  }

  // The run can take a while: just before the first write, look again at the pause switch and at the open orders.
  // Someone pausing the sync, or an open order changing on a planned item (a new order, one leaving the list, a
  // new line that cannot be placed), cancels this run (the next one starts fresh). -> 'ok' | 'replan'
  // 'replan' (once, when mayReplan): the only change is orders that went to HighDelivery (state "sent") since the
  // plan; their pieces are leaving the warehouse, so a fresh plan is safe and nothing has to wait an hour.
  async recheckBeforeWriting(outcome, { mayReplan }) {
    await this.checkStillLive(outcome, 'while the run was going');
    const orders = await this.readOpenOrders(outcome);
    const fresh = this.reserve(orders, outcome.warehouse);
    const known = new Set(outcome.unresolved.map((line) => String(line.productId)));
    const newUnresolved = fresh.unresolved.find((line) => !known.has(String(line.productId)));
    if (newUnresolved) {
      throw new SyncAbort('orders_changed', `a new open order line cannot be matched while the run was going (${newUnresolved.text})`);
    }
    const differs = (reservations) => writesOf(outcome.plan).find((row) => !row.hold && (reservations.get(row.hdId) || 0) !== row.reserved);
    const changed = differs(fresh.reservations);
    if (!changed) {
      return 'ok';
    }
    if (mayReplan) {
      const sent = await this.sentSincePlan(outcome.orders, orders);
      if (sent.size > 0) {
        const asPlanned = [...orders.filter((order) => !sent.has(String(order.id))), ...outcome.orders.filter((order) => sent.has(String(order.id)))];
        if (!differs(this.reserve(asPlanned, outcome.warehouse).reservations)) {
          return 'replan';
        }
      }
    }
    const now = fresh.reservations.get(changed.hdId) || 0;
    throw new SyncAbort('orders_changed', `open orders on HighDelivery item ${changed.hdId} went from ${changed.reserved} to ${now} reserved while the run was going`);
  }

  // Ids of the orders that were open and not yet at HighDelivery at plan time and are now in state "sent". An
  // order that left the list is looked up on its own (it is usually completed right after the send), at most 10.
  async sentSincePlan(before, now) {
    const nowById = new Map(now.map((order) => [String(order.id), order]));
    const sent = new Set();
    let lookups = 0;
    for (const order of before) {
      const id = String(order.id);
      if (readMeta(order, HD_META.state) === 'sent') {
        continue;
      }
      let current = nowById.get(id);
      if (!current && lookups < MAX_VANISHED_LOOKUPS) {
        lookups += 1;
        try {
          current = await this.wooClient.getOrder(id);
        } catch {
          current = null;
        }
      }
      if (current && readMeta(current, HD_META.state) === 'sent') {
        sent.add(id);
      }
    }
    return sent;
  }

  async checkStillLive(outcome, when) {
    const mode = describeMode(this.config.mode, await this.syncControl.read());
    this.lastMode = mode;
    outcome.mode = mode;
    if (mode.effective !== 'live') {
      throw new SyncAbort('mode_changed', `the sync was paused, or its control record became unreadable, ${when}`);
    }
  }

  // Writes the planned changes, one product at a time. The first failure stops everything after it; a pause set
  // between two products stops the rest.
  async applyWrites(outcome) {
    const byProduct = new Map();
    for (const row of writesOf(outcome.plan)) {
      byProduct.set(row.productId, [...(byProduct.get(row.productId) || []), row]);
    }
    const total = writesOf(outcome.plan).length;
    const at = outcome.at.toISOString();
    let first = true;
    for (const [productId, rows] of byProduct) {
      if (!first) {
        await this.sleep(this.config.writeDelayMs);
        await this.checkStillLive(outcome, `after ${outcome.written.length} of ${total} units were written`);
      }
      first = false;
      const failure = await this.writeProduct(productId, rows, { at, hash: outcome.hash, productsById: outcome.productsById }, outcome);
      if (failure) {
        outcome.errors += 1;
        outcome.aborted = 'write_failed';
        outcome.abortDetail = `stopped after ${outcome.written.length} of ${total} units: ${failure}`;
        return;
      }
    }
  }

  // Units whose stock is already right but which allow backorders: only backorders "no" is written. These never
  // change a stock number, so they are not part of the size limits or the plan hash. Live, not paused, only.
  async applyBackorderFixes(outcome) {
    const fixes = backorderFixesOf(outcome.plan);
    if (fixes.length === 0) {
      return;
    }
    await this.checkStillLive(outcome, 'before the backorders were turned off');
    const byProduct = new Map();
    for (const row of fixes) {
      byProduct.set(row.productId, [...(byProduct.get(row.productId) || []), row]);
    }
    for (const [productId, rows] of byProduct) {
      try {
        if (outcome.productsById.get(productId).type !== 'variable') {
          await this.wooClient.updateProduct(productId, { backorders: 'no' });
          outcome.backordersFixed.push(rows[0]);
          continue;
        }
        const answer = await this.wooClient.batchUpdateVariations(productId, rows.map((row) => ({ id: Number(row.unit), backorders: 'no' })));
        const ok = new Set((Array.isArray(answer?.update) ? answer.update : []).filter((item) => item && !item.error).map((item) => String(item.id)));
        outcome.backordersFixed.push(...rows.filter((row) => ok.has(row.unit)));
        if (rows.some((row) => !ok.has(row.unit))) {
          outcome.errors += 1;
        }
      } catch (error) {
        outcome.errors += 1;
        this.logger.warn(`[stock-sync] backorders of product ${productId} not turned off: ${shortReason(error)}`);
      }
    }
  }

  // Just before writing, the units' stock is read again: a unit whose stock moved since the plan (a sale, someone
  // editing it) is not written but marked "skipped_changed"; the next run plans it again. -> the rows still to write.
  async stillAsPlanned(product, rows, outcome) {
    let fresh;
    if (product.type === 'variable') {
      const variations = await this.wooClient.listVariations(product.id);
      fresh = (row) => variations.find((variation) => String(variation.id) === row.unit);
    } else {
      const now = await this.wooClient.getProduct(product.id);
      fresh = () => now;
    }
    return rows.filter((row) => {
      const entity = fresh(row);
      const stock = entity ? stockOf(entity) : null;
      if (stock && !stock.parentManaged && stock.current === row.current) {
        return true;
      }
      row.action = 'skipped_changed';
      row.why = `the stock changed from ${row.current ?? 'unmanaged'} to ${stock ? (stock.parentManaged ? 'parent-managed' : stock.current ?? 'unmanaged') : 'missing'} while the run was going; not written`;
      outcome.skippedChanged.push(row);
      return false;
    });
  }

  // -> '' when every row was written or skipped as changed, otherwise why it stopped. Written rows go to outcome.written.
  async writeProduct(productId, planned, { at, hash, productsById }, outcome) {
    const { written } = outcome;
    const product = productsById.get(productId);
    try {
      const rows = await this.stillAsPlanned(product, planned, outcome);
      if (rows.length === 0) {
        return '';
      }
      if (product.type !== 'variable') {
        await this.wooClient.updateProduct(productId, stockFields(rows[0], { at, hash }));
        written.push(rows[0]);
        return '';
      }
      for (const part of chunk(rows, MAX_BATCH_SIZE)) {
        const answer = await this.wooClient.batchUpdateVariations(productId, part.map((row) => ({ id: Number(row.unit), ...stockFields(row, { at, hash }) })));
        // Only a variation the shop answered for without an error counts as written.
        const replies = new Map((Array.isArray(answer?.update) ? answer.update : []).filter((item) => item && item.id !== undefined).map((item) => [String(item.id), item]));
        const problems = [];
        for (const row of part) {
          const reply = replies.get(row.unit);
          if (reply && !reply.error) {
            written.push(row);
          } else {
            problems.push([row.unit, reply ? shortReason(reply.error.message || reply.error.code) : 'the shop did not confirm it']);
          }
        }
        if (problems.length > 0) {
          const [unit, why] = problems[0];
          return `variation ${unit} of product ${productId}: ${why}`;
        }
      }
      return '';
    } catch (error) {
      return `product ${productId}: ${shortReason(error)}`;
    }
  }

  // Remembers the run (in memory and in WooCommerce), tells the team, logs one line.
  async finish(outcome) {
    const { at, plan } = outcome;
    const planned = writesOf(plan);
    const summary = {
      at: at.toISOString(),
      mode: outcome.runMode,
      checked: plan.length,
      changed: outcome.runMode === 'live' ? outcome.written.length : planned.length,
      skipped: plan.filter((row) => row.action.startsWith('skip_') || row.action === 'skipped_changed').length,
      skippedChanged: outcome.skippedChanged.length,
      backordersFixed: outcome.backordersFixed.length,
      ordersUnresolved: outcome.unresolved.length,
      oldOrdersReserving: outcome.oldReserving,
      replanned: outcome.replanned,
      errors: outcome.errors,
      skippedStatuses: outcome.skippedStatuses,
      aborted: outcome.aborted,
      abortDetail: outcome.abortDetail,
      planHash: outcome.hash || ''
    };
    this.last = { summary, plan, unlinked: outcome.unlinked, approvable: outcome.approvable };

    // With the mode off a manual preview only computes and answers: nothing is saved and nobody is messaged.
    if (outcome.mode.effective !== 'off') {
      const state = outcome.controlRead.state;
      const watched = await this.watchUnlinked(outcome, state);
      const alertedAbort = await this.alertAbort(outcome, state);
      await this.alertUnresolved(outcome);
      await this.saveRun(outcome, summary, { ...state, alerted: watched, last_abort_alert: alertedAbort });
    }

    this.logger.log(`[stock-sync] ${summary.aborted ? 'aborted' : 'completed'} mode=${summary.mode} checked=${summary.checked} changed=${summary.changed} skipped=${summary.skipped} errors=${summary.errors} aborted=${summary.aborted} hash=${summary.planHash.slice(0, 8)}`);
    return { mode: outcome.mode, summary, plan, ...(outcome.approval ? { approval: outcome.approval } : {}) };
  }

  async watchUnlinked(outcome, state) {
    if (!this.matchingWatch || !outcome.unlinked) {
      return state.alerted;
    }
    try {
      return await this.matchingWatch.alertNew({ unlinked: outcome.unlinked, alerted: state.alerted });
    } catch (error) {
      this.logger.warn(`[stock-sync] matching alert failed: ${shortReason(error)}`);
      return state.alerted;
    }
  }

  // Only a live setup tells the team; a dry run week must stay quiet. Same reason again within 6 hours stays silent.
  async alertAbort(outcome, state) {
    const previous = state.last_abort_alert;
    if (!outcome.aborted || this.config.mode !== 'live' || (!this.notify && !this.alert)) {
      return previous;
    }
    const recent = previous.reason === outcome.aborted && outcome.at.getTime() - Date.parse(previous.at) < ABORT_ALERT_GAP_MS;
    if (recent) {
      return previous;
    }
    let sent = 0;
    try {
      sent = await this.teamAlert({ key: `stock-sync-abort:${outcome.aborted}`, windowMs: ABORT_ALERT_GAP_MS, text: `Rhymat: synchro du stock arretee (${outcome.abortDetail || outcome.aborted}). ${outcome.written.length ? `${outcome.written.length} produits deja ecrits. ` : 'Rien n\'a ete ecrit. '}Voir Backend health dans l'app.` });
    } catch (error) {
      this.logger.warn(`[stock-sync] abort alert failed: ${shortReason(error)}`);
    }
    return sent ? { reason: outcome.aborted, at: outcome.at.toISOString() } : previous;
  }

  // A team message while open orders cannot be matched: their products are not being synced. Through the alert path
  // the same set of lines is told once per 6 hours (not every hourly run); a new line is told at once.
  async alertUnresolved(outcome) {
    if (outcome.unresolved.length === 0 || this.config.mode !== 'live' || (!this.notify && !this.alert)) {
      return;
    }
    const [first] = outcome.unresolved;
    const more = outcome.unresolved.length > 1 ? ` (+${outcome.unresolved.length - 1} autres lignes)` : '';
    const key = `stock-sync-unresolved:${createHash('sha256').update(outcome.unresolved.map((line) => line.text).sort().join('\n')).digest('hex').slice(0, 16)}`;
    try {
      await this.teamAlert({ key, text: `Rhymat: synchro du stock en pause pour un produit: ${shortReason(first.text)}${more}. Corriger le lien dans Matching ou fermer la commande.` });
    } catch (error) {
      this.logger.warn(`[stock-sync] unresolved-order alert failed: ${shortReason(error)}`);
    }
  }

  async saveRun(outcome, summary, state) {
    if (!outcome.controlRead.productId) {
      this.logger.warn(`[stock-sync] run history not saved: ${outcome.controlRead.error}`);
      return;
    }
    const entry = {
      at: summary.at, mode: summary.mode, checked: summary.checked, changed: summary.changed, skipped: summary.skipped, errors: summary.errors,
      aborted: summary.aborted, abort_detail: summary.abortDetail.replace(/["\\]/gu, "'"), plan_hash: summary.planHash,
      unresolved: summary.ordersUnresolved, old_reserving: summary.oldOrdersReserving,
      changes: (outcome.runMode === 'live' ? outcome.written : writesOf(outcome.plan)).slice(0, MAX_LISTED_CHANGES).map((row) => ({ unit: row.unit, product: row.productId, from: row.current, to: row.target }))
    };
    const older = state.runs.slice(-(MAX_RUNS - 1)).map(({ changes, ...counts }) => counts);
    try {
      await this.syncControl.saveState({ ...state, runs: [...older, entry] });
    } catch (error) {
      this.logger.warn(`[stock-sync] run history not saved: ${shortReason(error)}`);
    }
  }

  // GET /api/stock-sync/status
  async status() {
    const controlRead = await this.syncControl.read();
    const mode = describeMode(this.config.mode, controlRead);
    this.lastMode = mode;
    const saved = controlRead.state.runs.at(-1);
    const lastRun = this.last?.summary || (saved ? {
      at: saved.at, mode: saved.mode, checked: saved.checked, changed: saved.changed, skipped: saved.skipped, errors: saved.errors,
      aborted: saved.aborted, abortDetail: saved.abort_detail || '', planHash: saved.plan_hash || ''
    } : null);
    return {
      mode,
      running: this.running,
      lastRun,
      plan: this.last?.plan || [],
      unlinked: { woo: this.last?.unlinked?.woo || [], hd: this.last?.unlinked?.hd || [] },
      brokenLinks: this.last?.unlinked?.broken || []
    };
  }

  // What the health page shows. From memory only (no calls): the last run since this process started.
  healthSnapshot() {
    const unlinked = this.last?.unlinked;
    return {
      mode: this.lastMode || { env: this.config.mode, paused: null, effective: this.config.mode === 'off' ? 'off' : 'dry_run', controlProblem: '' },
      lastRun: this.last?.summary || null,
      approvable: Boolean(this.last?.approvable),
      unlinked: { woo: unlinked?.woo.length || 0, hd: unlinked?.hd.length || 0, products: new Set((unlinked?.woo || []).map((row) => row.productId)).size },
      brokenLinks: unlinked?.broken.length || 0,
      badDocs: unlinked?.badDocs.length || 0
    };
  }
}

function stockFields(row, { at, hash }) {
  const audit = { at, run: hash.slice(0, 8), from: row.current, to: row.target, hd: row.hd, reserved: row.reserved, offset: row.offset, cap: row.cap, hold: row.hold };
  return {
    manage_stock: true,
    backorders: 'no',
    stock_quantity: row.target,
    stock_status: row.target > 0 ? 'instock' : 'outofstock',
    meta_data: [{ key: LINK_META.last, value: canonicalJson(audit) }]
  };
}
