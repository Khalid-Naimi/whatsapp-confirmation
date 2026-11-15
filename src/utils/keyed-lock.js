// In-memory per-key locks (one process only; services/claim.js guards across instances).
//
// run(key, work): the order lock the confirmation service has always used, moved here unchanged. It is re-entrant by
// a depth counter per key: while a key is held, ANY other run() for the same key goes straight through (that is what
// lets a step call another step that takes the same lock). Note that this also means two independent concurrent
// callers for one key are not kept apart; the send paths rely on the WooCommerce reservation and claim for that.
//
// tryRun(key, work): the "already running, skip" guard of the HighDelivery auto-send. Never waits: when the key is
// held it returns { ran: false } at once. `held` is the set of keys being run (callers may look at it).
export class KeyedLock {
  constructor({ prefix = '', logger = console } = {}) {
    this.prefix = prefix;
    this.logger = logger;
    this.depths = new Map();
    this.mutexes = new Map();
    this.held = new Set();
  }

  async run(key, work) {
    const lockKey = `${this.prefix}${key}`;
    const currentDepth = this.depths.get(lockKey) || 0;
    if (currentDepth > 0) {
      this.depths.set(lockKey, currentDepth + 1);
      try {
        return await work();
      } finally {
        this.depths.set(lockKey, currentDepth);
      }
    }

    while (this.mutexes.has(lockKey)) {
      await this.mutexes.get(lockKey);
    }

    let releaseLock;
    const pendingLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    this.mutexes.set(lockKey, pendingLock);
    this.log(`[lock] acquired lockKey=${lockKey}`);
    this.depths.set(lockKey, 1);
    try {
      return await work();
    } finally {
      this.depths.delete(lockKey);
      this.mutexes.delete(lockKey);
      releaseLock();
      this.log(`[lock] released lockKey=${lockKey}`);
    }
  }

  // `logger` may be a function returning the logger, so an owner that swaps its logger keeps the lock lines with it.
  log(message) {
    const logger = typeof this.logger === 'function' ? this.logger() : this.logger;
    logger?.log?.(message);
  }

  async tryRun(key, work) {
    if (this.held.has(key)) {
      return { ran: false };
    }
    this.held.add(key);
    try {
      return { ran: true, value: await work() };
    } finally {
      this.held.delete(key);
    }
  }
}
