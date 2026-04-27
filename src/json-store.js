import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EMPTY_DB = {
  orders: [],
  messages: [],
  events: [],
  contacts: []
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.ensureFile();
  }

  ensureFile() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(EMPTY_DB, null, 2));
    }
  }

  read() {
    this.ensureFile();
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(db) {
    fs.writeFileSync(this.filePath, JSON.stringify(db, null, 2));
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
        payload,
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
