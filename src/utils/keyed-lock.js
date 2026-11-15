import { AsyncLocalStorage } from 'node:async_hooks';

// In-memory per-key locks (one process only; services/claim.js guards across instances).
//
// run(key, work): a real mutex per key. Callers for the same key run one after the other, in arrival order.
// Re-entry: a call made from inside the work itself (the same async call chain, e.g. a step that calls another step
// taking the same order lock) runs at once instead of deadlocking. Each acquisition gets an owner token, carried in
// the async context (AsyncLocalStorage); a call re-enters only while its chain carries the token of the CURRENT
// holder. The token is dropped on release, so a timer or callback scheduled inside the lock that fires after the
// release does not slip past the next holder: it queues like anyone else.
//
// tryRun(key, work): the "already running, skip" guard of the HighDelivery auto-send. Never waits: when the key is
// held it returns { ran: false } at once. `held` is the set of keys being run (callers may look at it).
const chain = new AsyncLocalStorage();

export class KeyedLock {
  constructor({ prefix = '', logger = console } = {}) {
    this.prefix = prefix;
    this.logger = logger;
    // lockKey -> owner token of the current holder (named depths for the old callers that look at it).
    this.depths = new Map();
    // lockKey -> the end of the waiting line (named mutexes for the old callers that look at it).
    this.mutexes = new Map();
    this.held = new Set();
  }

  async run(key, work) {
    const lockKey = `${this.prefix}${key}`;
    const tokens = chain.getStore();
    const owner = this.depths.get(lockKey);
    if (owner && tokens?.has(owner)) {
      return work();
    }

    const previous = this.mutexes.get(lockKey) || Promise.resolve();
    let releaseLock;
    const mine = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const tail = previous.then(() => mine);
    this.mutexes.set(lockKey, tail);
    await previous;

    const token = Symbol(lockKey);
    this.depths.set(lockKey, token);
    this.log(`[lock] acquired lockKey=${lockKey}`);
    try {
      return await chain.run(new Set([...(tokens || []), token]), work);
    } finally {
      this.depths.delete(lockKey);
      if (this.mutexes.get(lockKey) === tail) {
        this.mutexes.delete(lockKey);
      }
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
