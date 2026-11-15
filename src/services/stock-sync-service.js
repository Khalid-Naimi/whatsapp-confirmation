import { createHash } from 'node:crypto';
import { HD_META } from './hd-auto-send-service.js';
import { warehouseQuantity } from './hd-product-match.js';
import { findUnlinked } from './matching-watch.js';
import { resolveOrderLines } from './order-resolver.js';
import { LINK_META, canonicalJson, readMeta } from './product-links.js';

const MAX_VARIATION_ERRORS = 3;
const MAX_RUNS = 24;
const MAX_LISTED_CHANGES = 50;
const MAX_BATCH_SIZE = 100;
const MAX_MISSING_HD_SHARE = 0.2;
const ABORT_ALERT_GAP_MS = 6 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// Pure part: no calls, no clock.
// ---------------------------------------------------------------------------------------------------------------

// What the shop may show online for one unit. The desktop app uses the same formula and the same fixture.
//   hold: forced to 0. Otherwise the HighDelivery quantity minus what open orders still need, minus the offset
//   kept back, never below 0, and never above the cap (max_online).
export function computeTarget(hdQty, reserved, unit) {
  if (unit.hold) {
    return 0;
  }
  const available = Math.max(0, hdQty - reserved - unit.offset);
  return unit.max_online === null ? available : Math.min(available, unit.max_online);
}

// Units of each HighDelivery item that open orders will still take: Map hdId -> quantity.
// An order that is already at HighDelivery (state "sent") has been taken out of the HighDelivery stock; every
// other open order counts, including "sending" and "unknown" (counting an order twice only under-sells).
//   resolveLines(lineItems) -> [{ hdId, quantity }]
export function computeReservations(orders, resolveLines) {
  const reserved = new Map();
  for (const order of orders) {
    if (readMeta(order, HD_META.state) === 'sent') {
      continue;
    }
    for (const { hdId, quantity } of resolveLines(order.line_items)) {
      reserved.set(hdId, (reserved.get(hdId) || 0) + quantity);
    }
  }
  return reserved;
}

function stockOf(entity) {
  const managed = entity.manage_stock === true;
  return { managed, current: managed && Number.isInteger(entity.stock_quantity) ? entity.stock_quantity : null };
}

// The stock now in the shop for a unit, or null when the unit does not exist (or its variations were not read).
function currentStock(product, key, variations) {
  if (product.type === 'variable') {
    const variation = key === 'p' ? null : (variations || []).find((candidate) => String(candidate.id) === key);
    return variation ? stockOf(variation) : null;
  }
  return key === 'p' ? stockOf(product) : null;
}

function explain({ hd, reserved, unit, target }) {
  if (unit.hold) {
    return 'on hold: online stock is 0';
  }
  const text = `hd ${hd} - reserved ${reserved} - offset ${unit.offset} = ${Math.max(0, hd - reserved - unit.offset)}`;
  return unit.max_online !== null && target === unit.max_online ? `${text}, capped at ${unit.max_online}` : text;
}

function rowFor(product, key, unit) {
  const item = unit.items[0];
  return {
    productId: product.id, unit: key, label: unit.label, hdId: item ? item.hd_id : null, hdName: item ? item.hd_name : '',
    hd: null, reserved: 0, offset: unit.offset, cap: unit.max_online, hold: unit.hold, current: null, target: null, action: '', why: ''
  };
}

// One row per unit of every readable link document. Only units with writer "server" and sync on get a target.
//   products             [{ product, link }] from the LinkIndex
//   variationsByProduct  Map productId -> variations
//   warehouse            HighDelivery rows
//   reservations         Map hdId -> quantity
function planUnit(product, key, unit, { variationsByProduct, hdById, reservations }) {
  const row = rowFor(product, key, unit);
  const skip = (action, why) => ({ ...row, action, why });
  if (unit.writer !== 'server') {
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
  const base = { ...row, current: stock.current };
  const finish = (target, hd, reserved) => {
    const same = stock.managed && stock.current === target;
    const filled = { ...base, hd, reserved, target };
    return { ...filled, action: same ? 'same' : 'write', why: explain({ hd, reserved, unit, target }) };
  };
  if (unit.hold) {
    return finish(0, null, 0);
  }
  const hdRow = hdById.get(unit.items[0].hd_id);
  if (!hdRow) {
    return { ...base, action: 'skip_hd_missing', why: `HighDelivery item ${unit.items[0].hd_id} was not in the list` };
  }
  const hd = warehouseQuantity(hdRow);
  const reserved = reservations.get(unit.items[0].hd_id) || 0;
  return finish(computeTarget(hd, reserved, unit), hd, reserved);
}

export function computeStockPlan({ products, variationsByProduct, warehouse, reservations }) {
  const hdById = new Map(warehouse.map((row) => [Number(row.id), row]));
  const context = { variationsByProduct, hdById, reservations };
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
  return rows;
}

const writesOf = (plan) => plan.filter((row) => row.action === 'write');
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
  const linkedIds = new Set(plan.filter((row) => row.hdId !== null && ['write', 'same', 'skip_hd_missing'].includes(row.action)).map((row) => row.hdId));
  const missingIds = new Set(plan.filter((row) => row.action === 'skip_hd_missing').map((row) => row.hdId));
  if (linkedIds.size > 0 && missingIds.size / linkedIds.size > MAX_MISSING_HD_SHARE) {
    fail('hd_ids_missing', `${missingIds.size} of ${linkedIds.size} linked HighDelivery items are missing from its list`, false);
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
  constructor({ wooClient, hdClient, linkIndex, syncControl, productMap, matchingWatch = null, notify = null, config, logger = console, now = () => new Date(), sleepImpl = sleep }) {
    this.wooClient = wooClient;
    this.hdClient = hdClient;
    this.linkIndex = linkIndex;
    this.syncControl = syncControl;
    this.productMap = productMap;
    this.matchingWatch = matchingWatch;
    this.notify = notify;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.sleep = sleepImpl;
    this.running = false;
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
    try {
      return await this.execute({ dryRun, approveHash });
    } finally {
      this.running = false;
    }
  }

  async execute({ dryRun, approveHash }) {
    const at = this.now();
    const controlRead = await this.syncControl.read();
    const mode = describeMode(this.config.mode, controlRead);
    this.lastMode = mode;
    const writesAllowed = !dryRun && mode.effective === 'live';
    const outcome = { at, mode, runMode: writesAllowed ? 'live' : 'dry_run', controlRead, plan: [], unlinked: null, errors: 0, written: [], aborted: '', abortDetail: '', approvable: false, approval: '' };

    try {
      await this.compute(outcome);
      this.decide(outcome, { writesAllowed, approveHash });
      if (outcome.apply) {
        await this.applyWrites(outcome);
      }
    } catch (error) {
      if (!(error instanceof SyncAbort)) {
        throw error;
      }
      outcome.aborted = error.reason;
      outcome.abortDetail = shortReason(error.message);
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
    const { reserveStatuses, reserveDays } = this.config;
    await this.step('woo_products_failed', () => this.linkIndex.load());
    const products = this.linkIndex.products();
    outcome.productsById = new Map(products.map(({ product }) => [product.id, product]));
    const warehouse = await this.step('hd_unavailable', () => this.hdClient.listWarehouseProducts());
    const after = new Date(this.now().getTime() - reserveDays * 24 * 60 * 60 * 1000).toISOString();
    const orders = await this.step('orders_failed', () => this.wooClient.listOpenOrdersLite(reserveStatuses, { after }));
    const variationsByProduct = await this.readVariations(products, outcome);

    const resolveLines = (lineItems) => {
      const { wanted } = resolveOrderLines(lineItems, { unitLookup: (productId, variationId) => this.linkIndex.lookup(productId, variationId), csvMap: this.productMap, warehouse });
      return [...wanted.values()].map(({ product, quantity }) => ({ hdId: Number(product.id), quantity }));
    };
    const reservations = computeReservations(orders, resolveLines);
    outcome.plan = computeStockPlan({ products, variationsByProduct, warehouse, reservations });
    outcome.hash = planHash(outcome.plan);
    outcome.guards = checkGuards(outcome.plan, { warehouse, limits: this.config });
    outcome.unlinked = findUnlinked({ products, variationsByProduct, warehouse, control: outcome.controlRead.control });
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

  // Writes the planned changes, one product at a time. The first failure stops everything after it.
  async applyWrites(outcome) {
    const byProduct = new Map();
    for (const row of writesOf(outcome.plan)) {
      byProduct.set(row.productId, [...(byProduct.get(row.productId) || []), row]);
    }
    const at = outcome.at.toISOString();
    let first = true;
    for (const [productId, rows] of byProduct) {
      if (!first) {
        await this.sleep(this.config.writeDelayMs);
      }
      first = false;
      const failure = await this.writeProduct(productId, rows, { at, hash: outcome.hash, productsById: outcome.productsById }, outcome.written);
      if (failure) {
        outcome.errors += 1;
        outcome.aborted = 'write_failed';
        outcome.abortDetail = `stopped after ${outcome.written.length} of ${writesOf(outcome.plan).length} units: ${failure}`;
        return;
      }
    }
  }

  // -> '' when every row was written, otherwise why it stopped. Written rows are added to `written`.
  async writeProduct(productId, rows, { at, hash, productsById }, written) {
    const product = productsById.get(productId);
    try {
      if (product.type !== 'variable') {
        await this.wooClient.updateProduct(productId, stockFields(rows[0], { at, hash }));
        written.push(rows[0]);
        return '';
      }
      for (const part of chunk(rows, MAX_BATCH_SIZE)) {
        const answer = await this.wooClient.batchUpdateVariations(productId, part.map((row) => ({ id: Number(row.unit), ...stockFields(row, { at, hash }) })));
        const refused = new Map((answer?.update || []).filter((item) => item?.error).map((item) => [String(item.id), item.error]));
        written.push(...part.filter((row) => !refused.has(row.unit)));
        if (refused.size > 0) {
          const [unit, error] = [...refused][0];
          return `variation ${unit} of product ${productId}: ${shortReason(error.message || error.code)}`;
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
      skipped: plan.filter((row) => row.action.startsWith('skip_')).length,
      errors: outcome.errors,
      aborted: outcome.aborted,
      abortDetail: outcome.abortDetail,
      planHash: outcome.hash || ''
    };
    this.last = { summary, plan, unlinked: outcome.unlinked, approvable: outcome.approvable };

    const state = outcome.controlRead.state;
    const watched = await this.watchUnlinked(outcome, state);
    const alertedAbort = await this.alertAbort(outcome, state);
    await this.saveRun(outcome, summary, { ...state, alerted: watched, last_abort_alert: alertedAbort });

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
    if (!outcome.aborted || this.config.mode !== 'live' || !this.notify) {
      return previous;
    }
    const recent = previous.reason === outcome.aborted && outcome.at.getTime() - Date.parse(previous.at) < ABORT_ALERT_GAP_MS;
    if (recent) {
      return previous;
    }
    const sent = await this.notify(`Rhymat: synchro du stock arretee (${outcome.abortDetail || outcome.aborted}). ${outcome.written.length ? `${outcome.written.length} produits deja ecrits. ` : 'Rien n\'a ete ecrit. '}Voir Backend health dans l'app.`);
    return sent ? { reason: outcome.aborted, at: outcome.at.toISOString() } : previous;
  }

  async saveRun(outcome, summary, state) {
    if (!outcome.controlRead.productId) {
      this.logger.warn(`[stock-sync] run history not saved: ${outcome.controlRead.error}`);
      return;
    }
    const entry = {
      at: summary.at, mode: summary.mode, checked: summary.checked, changed: summary.changed, skipped: summary.skipped, errors: summary.errors,
      aborted: summary.aborted, abort_detail: summary.abortDetail.replace(/["\\]/gu, "'"), plan_hash: summary.planHash,
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
    stock_quantity: row.target,
    stock_status: row.target > 0 ? 'instock' : 'outofstock',
    meta_data: [{ key: LINK_META.last, value: canonicalJson(audit) }]
  };
}
