import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The file lives on the server's own disk, which Render wipes on every deploy or restart: it is a fast local cache and a
// debug history, never the only copy of anything that must survive (see services/durable-state.js).
export const STORE_LIMITS = Object.freeze({ events: 5000, messages: 5000, stockAlerts: 5000 });

// Orders older than this (by their last update) are dropped from the local file unless they are still open: waiting
// for the customer's confirmation or feedback. Contacts are never dropped.
export const ORDER_KEEP_DAYS = 120;
const OPEN_CONFIRMATION_STATES = new Set(['pending_confirmation']);
const OPEN_FEEDBACK_STATES = new Set(['waiting_for_feedback']);
const DAY_MS = 24 * 60 * 60 * 1000;
export const FLUSH_INTERVAL_MS = 1000;

function emptyDb() {
  return { orders: [], messages: [], events: [], contacts: [] };
}

// Every store still alive gets a last flush when the process exits (a script ends, the server stops), so a change
// waiting for its timer is never lost. One listener for all stores; a store that was collected is skipped.
const liveStores = new Set();
let exitHookInstalled = false;
function flushAtExit(store) {
  liveStores.add(new WeakRef(store));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const ref of liveStores) {
        ref.deref()?.flush();
      }
    });
  }
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// The data lives in memory; the file is written at most once per `flushIntervalMs` (the first change after a quiet
// second at once, later ones together a moment after) and by flush() (called on SIGTERM and at process exit).
// Every read hands out a copy, so a caller can never change the store by accident.
export class JsonStore {
  constructor(filePath, { logger = console, limits = STORE_LIMITS, flushIntervalMs = FLUSH_INTERVAL_MS, orderKeepDays = ORDER_KEEP_DAYS, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.limits = { ...STORE_LIMITS, ...(limits || {}) };
    this.flushIntervalMs = flushIntervalMs;
    this.orderKeepDays = orderKeepDays;
    this.now = now;
    this.lastFlushAt = 0;
    this.flushTimer = null;
    this.dirty = false;
    this.flushCount = 0;
    this.ensureFile();
    this.db = this.load();
    flushAtExit(this);
  }

  ensureFile() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.writeFile(emptyDb());
    }
  }

  // A missing or empty file is an empty store. A file that cannot be parsed is moved aside (never deleted) and the
  // service starts empty, so one bad write can never stop the webhooks.
  load() {
    let text = '';
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return emptyDb();
      }
      throw error;
    }
    if (!text.trim()) {
      return emptyDb();
    }
    let db;
    try {
      db = JSON.parse(text);
    } catch {
      db = null;
    }
    if (!db || typeof db !== 'object' || Array.isArray(db)) {
      return this.quarantineCorruptFile();
    }
    for (const key of ['orders', 'messages', 'events', 'contacts']) {
      if (!Array.isArray(db[key])) {
        db[key] = [];
      }
    }
    return db;
  }

  // A copy of everything (same shape as the file).
  read() {
    return clone(this.db);
  }

  quarantineCorruptFile() {
    const aside = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    try {
      fs.renameSync(this.filePath, aside);
      this.logger.error(`[store] the data file could not be read; it was moved to ${path.basename(aside)} and the service starts with an empty local cache`);
    } catch (error) {
      this.logger.error(`[store] the data file could not be read and could not be moved aside (${error.message}); starting with an empty local cache`);
    }
    const db = emptyDb();
    this.writeFile(db);
    return db;
  }

  // Replaces the whole content (capped) and schedules the file write.
  write(db) {
    this.applyCaps(db);
    this.db = clone(db);
    this.scheduleFlush();
  }

  applyCaps(db) {
    capList(db, 'events', this.limits.events);
    capList(db, 'messages', this.limits.messages);
    capList(db, 'stockAlerts', this.limits.stockAlerts);
    capOrdersByAge(db, this.now() - this.orderKeepDays * DAY_MS);
  }

  // Atomic: the new content goes to a temporary file in the same folder and replaces the old file in one rename, so a
  // crash mid-write leaves either the old or the new file, never half of one.
  writeFile(db) {
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing left to clean
      }
      throw error;
    }
  }

  scheduleFlush() {
    this.dirty = true;
    if (this.flushTimer) {
      return;
    }
    const wait = this.lastFlushAt + this.flushIntervalMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => this.flush(), wait);
    this.flushTimer.unref?.();
  }

  // Writes the file now if anything changed since the last write. Never throws: a failed write is logged and the
  // data stays in memory (marked dirty) for the next try. -> true when the file is up to date.
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) {
      return true;
    }
    try {
      this.writeFile(this.db);
      this.dirty = false;
      this.flushCount += 1;
      return true;
    } catch (error) {
      this.logger.error(`[store] the data file could not be written (${error.message}); the data stays in memory and is written with the next change`);
      return false;
    } finally {
      this.lastFlushAt = this.now();
    }
  }

  // The mutator works on a copy; only when it returns without throwing does the copy become the store.
  transaction(mutator) {
    const db = clone(this.db);
    const result = mutator(db);
    this.applyCaps(db);
    this.db = db;
    this.scheduleFlush();
    return clone(result);
  }

  hasProcessedEvent(source, eventKey) {
    const db = this.db;
    return db.events.some((event) => event.source === source && event.eventKey === eventKey);
  }

  recordEvent(source, eventKey, payload, status = 'processed') {
    return this.transaction((db) => {
      const existing = db.events.find((event) => event.source === source && event.eventKey === eventKey);
      if (existing) {
        return existing;
      }

      const record = {
        id: crypto.randomUUID(),
        source,
        eventKey,
        // Only a small summary: the full webhook body (customer names, addresses, phones) is not kept on disk.
        payload: summarizeEventPayload(payload),
        status,
        createdAt: new Date().toISOString()
      };
      db.events.push(record);
      return record;
    });
  }

  upsertOrder(order) {
    return this.transaction((db) => {
      const index = db.orders.findIndex((item) => item.orderId === order.orderId);
      const nextOrder = {
        ...db.orders[index],
        ...order,
        updatedAt: new Date().toISOString()
      };

      if (!nextOrder.createdAt) {
        nextOrder.createdAt = nextOrder.updatedAt;
      }

      if (index >= 0) {
        db.orders[index] = nextOrder;
      } else {
        db.orders.push(nextOrder);
      }

      return nextOrder;
    });
  }

  appendMessage(message) {
    return this.transaction((db) => {
      const record = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...message
      };
      db.messages.push(record);
      return record;
    });
  }

  getOrder(orderId) {
    return clone(this.db.orders.find((order) => order.orderId === orderId)) || null;
  }

  findLatestPendingOrderByPhone(phone) {
    return clone(this.db.orders
      .filter((order) => order.phone === phone && order.confirmationState === 'pending_confirmation')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]) || null;
  }

  findLatestOrderByPhone(phone) {
    return clone(this.db.orders
      .filter((order) => order.phone === phone)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]) || null;
  }

  listActiveSelfTestFeedbackOrdersByPhone(phone) {
    return clone(this.db.orders
      .filter((order) =>
        order.feedbackState === 'waiting_for_feedback' &&
        (order.feedbackTestActive === true || order.feedbackIsTest === true) &&
        order.feedbackTestPhone === phone
      )
      .sort(compareActiveSelfTestOrders));
  }

  listActiveProductionFeedbackOrdersByPhone(phone) {
    return clone(this.db.orders
      .filter((order) =>
        order.feedbackState === 'waiting_for_feedback' &&
        order.phone === phone &&
        order.feedbackTestActive !== true &&
        order.feedbackIsTest !== true
      )
      .sort(compareActiveSelfTestOrders));
  }

  findLatestActiveSelfTestFeedbackOrderByPhone(phone) {
    return this.listActiveSelfTestFeedbackOrdersByPhone(phone)[0] || null;
  }

  // Orders whose new address or phone waits for this number's "1".
  listContactRequestsByPhone(phone) {
    return clone(this.db.orders.filter((order) => order.contactPhone === phone && order.contactAskedAt));
  }

  listPendingOrdersByPhone(phone) {
    return clone(this.db.orders.filter((order) => order.phone === phone && order.confirmationState === 'pending_confirmation'));
  }

  listOrders(status) {
    if (status) {
      return clone(this.db.orders.filter((order) => order.confirmationState === status));
    }
    return clone(this.db.orders);
  }

  getOrdersSummary() {
    const db = this.db;
    const summary = { total: db.orders.length };
    for (const order of db.orders) {
      const state = order.confirmationState || 'unknown';
      summary[state] = (summary[state] || 0) + 1;
    }
    return summary;
  }

  getMessagesByOrder(orderId) {
    return clone(this.db.messages.filter((msg) => msg.orderId === orderId));
  }

  getMessagesByPhone(phone) {
    return clone(this.db.messages.filter((msg) => msg.phone === phone));
  }

  // The daily caps of the /suivi page messages (one day at a time). Wiped with the disk, which only loosens them.
  getManageDaily(day) {
    const current = this.db.manageDaily;
    return current?.day === day ? clone(current) : { day, shop: 0, phones: {}, alerted: false };
  }

  updateManageDaily(day, mutator) {
    return this.transaction((db) => {
      const current = db.manageDaily?.day === day ? db.manageDaily : { day, shop: 0, phones: {}, alerted: false };
      mutator(current);
      db.manageDaily = current;
      return current;
    });
  }

  upsertContact(contact) {
    return this.transaction((db) => {
      if (!db.contacts) {
        db.contacts = [];
      }
      const index = db.contacts.findIndex((c) => c.phone === contact.phone);
      const now = new Date().toISOString();
      const next = {
        ...db.contacts[index],
        ...contact,
        updatedAt: now
      };
      if (!next.createdAt) {
        next.createdAt = now;
      }
      if (index >= 0) {
        db.contacts[index] = next;
      } else {
        db.contacts.push(next);
      }
      return next;
    });
  }

  getContact(phone) {
    return clone((this.db.contacts || []).find((c) => c.phone === phone)) || null;
  }

  listOptedOutContacts() {
    return clone((this.db.contacts || []).filter((c) => c.marketingStatus === 'opted_out'));
  }

  isPhoneOptedOut(phone) {
    return Boolean(this.getContact(phone)?.marketingStatus === 'opted_out');
  }
}

function capOrdersByAge(db, cutoffMs) {
  if (!Array.isArray(db?.orders)) {
    return;
  }
  db.orders = db.orders.filter((order) => {
    if (OPEN_CONFIRMATION_STATES.has(order?.confirmationState) || OPEN_FEEDBACK_STATES.has(order?.feedbackState)) {
      return true;
    }
    const last = Math.max(Date.parse(order?.updatedAt || '') || 0, Date.parse(order?.createdAt || '') || 0);
    // No readable date: kept (it cannot be told apart from a new order).
    return last === 0 || last >= cutoffMs;
  });
}

function capList(db, key, max) {
  if (Array.isArray(db?.[key]) && Number.isFinite(max) && max > 0 && db[key].length > max) {
    db[key] = db[key].slice(-max);
  }
}

// Ids, status and the shape of a webhook body: enough to debug, nothing personal.
export function summarizeEventPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const summary = {};
  for (const key of ['id', 'status', 'event', 'eventKey', 'index', 'providerMessageId']) {
    const value = payload[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      summary[key] = typeof value === 'string' ? value.slice(0, 120) : value;
    }
  }
  summary.keys = Object.keys(payload).sort().slice(0, 30);
  return summary;
}

function compareActiveSelfTestOrders(left, right) {
  const sentDelta = getTimestampValue(right.feedbackSentAt) - getTimestampValue(left.feedbackSentAt);
  if (sentDelta !== 0) {
    return sentDelta;
  }

  const requestedDelta = getTimestampValue(right.feedbackRequestedAt) - getTimestampValue(left.feedbackRequestedAt);
  if (requestedDelta !== 0) {
    return requestedDelta;
  }

  const updatedDelta = getTimestampValue(right.updatedAt) - getTimestampValue(left.updatedAt);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return Number(right.orderId || 0) - Number(left.orderId || 0);
}

function getTimestampValue(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
