import fs from 'node:fs';
import path from 'node:path';

const EMPTY_DB = {
  orders: [],
  messages: [],
  events: []
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

  listPendingOrdersByPhone(phone) {
    const db = this.read();
    return db.orders.filter((order) => order.phone === phone && order.confirmationState === 'pending_confirmation');
  }
}
