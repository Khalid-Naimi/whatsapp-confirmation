import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The file lives on the server's own disk, which Render wipes on every deploy or restart: it is a fast local cache and a
// debug history, never the only copy of anything that must survive (see services/durable-state.js).
export const STORE_LIMITS = Object.freeze({ events: 5000, messages: 5000, stockAlerts: 5000 });

function emptyDb() {
  return { orders: [], messages: [], events: [], contacts: [] };
}

export class JsonStore {
  constructor(filePath, { logger = console, limits = STORE_LIMITS } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.limits = { ...STORE_LIMITS, ...(limits || {}) };
    this.ensureFile();
  }

  ensureFile() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(emptyDb());
    }
  }

  // A missing or empty file is an empty store. A file that cannot be parsed is moved aside (never deleted) and the
  // service starts empty, so one bad write can never stop the webhooks.
  read() {
    this.ensureFile();
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

  quarantineCorruptFile() {
    const aside = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    try {
      fs.renameSync(this.filePath, aside);
      this.logger.error(`[store] the data file could not be read; it was moved to ${path.basename(aside)} and the service starts with an empty local cache`);
    } catch (error) {
      this.logger.error(`[store] the data file could not be read and could not be moved aside (${error.message}); starting with an empty local cache`);
    }
    const db = emptyDb();
    this.write(db);
    return db;
  }

  // Atomic: the new content goes to a temporary file in the same folder and replaces the old file in one rename, so a
  // crash mid-write leaves either the old or the new file, never half of one. The history lists are capped.
  write(db) {
    capList(db, 'events', this.limits.events);
    capList(db, 'messages', this.limits.messages);
    capList(db, 'stockAlerts', this.limits.stockAlerts);
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

  transaction(mutator) {
    const db = this.read();
    const result = mutator(db);
    this.write(db);
    return result;
  }

  hasProcessedEvent(source, eventKey) {
    const db = this.read();
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
    const db = this.read();
    return db.orders.find((order) => order.orderId === orderId) || null;
  }

  findLatestPendingOrderByPhone(phone) {
    const db = this.read();
    return db.orders
      .filter((order) => order.phone === phone && order.confirmationState === 'pending_confirmation')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  }

  findLatestOrderByPhone(phone) {
    const db = this.read();
    return db.orders
      .filter((order) => order.phone === phone)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  }

  listActiveSelfTestFeedbackOrdersByPhone(phone) {
    const db = this.read();
    return db.orders
      .filter((order) =>
        order.feedbackState === 'waiting_for_feedback' &&
        (order.feedbackTestActive === true || order.feedbackIsTest === true) &&
        order.feedbackTestPhone === phone
      )
      .sort(compareActiveSelfTestOrders);
  }

  listActiveProductionFeedbackOrdersByPhone(phone) {
    const db = this.read();
    return db.orders
      .filter((order) =>
        order.feedbackState === 'waiting_for_feedback' &&
        order.phone === phone &&
        order.feedbackTestActive !== true &&
        order.feedbackIsTest !== true
      )
      .sort(compareActiveSelfTestOrders);
  }

  findLatestActiveSelfTestFeedbackOrderByPhone(phone) {
    return this.listActiveSelfTestFeedbackOrdersByPhone(phone)[0] || null;
  }

  listPendingOrdersByPhone(phone) {
    const db = this.read();
    return db.orders.filter((order) => order.phone === phone && order.confirmationState === 'pending_confirmation');
  }

  listOrders(status) {
    const db = this.read();
    if (status) {
      return db.orders.filter((order) => order.confirmationState === status);
    }
    return db.orders;
  }

  getOrdersSummary() {
    const db = this.read();
    const summary = { total: db.orders.length };
    for (const order of db.orders) {
      const state = order.confirmationState || 'unknown';
      summary[state] = (summary[state] || 0) + 1;
    }
    return summary;
  }

  getMessagesByOrder(orderId) {
    const db = this.read();
    return db.messages.filter((msg) => msg.orderId === orderId);
  }

  getMessagesByPhone(phone) {
    const db = this.read();
    return db.messages.filter((msg) => msg.phone === phone);
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
    const db = this.read();
    return (db.contacts || []).find((c) => c.phone === phone) || null;
  }

  listOptedOutContacts() {
    const db = this.read();
    return (db.contacts || []).filter((c) => c.marketingStatus === 'opted_out');
  }

  isPhoneOptedOut(phone) {
    return Boolean(this.getContact(phone)?.marketingStatus === 'opted_out');
  }
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
