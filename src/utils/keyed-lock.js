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

// Runs `start` outside every held lock: a background task or timer started from inside a lock must not carry the
// holder's token (it would otherwise re-enter while the holder still holds the key). Returns what `start` returns.
export function outsideLocks(start) {
  return chain.exit(start);
}

// A waiter that gave up: the key was held longer than the lock's timeout. Callers treat it like any other failure.
export class LockTimeoutError extends Error {
  constructor(lockKey, waitedMs) {
    super(`waited ${Math.round(waitedMs / 1000)} s for ${lockKey}; gave up`);
    this.name = 'LockTimeoutError';
    this.lockKey = lockKey;
  }
}

export const LOCK_WARN_AFTER_MS = 60 * 1000;
export const LOCK_TIMEOUT_MS = 180 * 1000;

export class KeyedLock {
  constructor({ prefix = '', logger = console, warnAfterMs = LOCK_WARN_AFTER_MS, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    this.prefix = prefix;
    this.logger = logger;
    // A wait longer than warnAfterMs is logged; after timeoutMs the waiter gives up (LockTimeoutError) instead of
    // waiting forever behind a holder that never finishes.
    this.warnAfterMs = warnAfterMs;
    this.timeoutMs = timeoutMs;
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
    await this.waitFor(previous, lockKey, releaseLock);

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

  // Waits for the previous holder. Logs once after warnAfterMs; after timeoutMs gives up: its own place in the line
  // is released at once (so the callers behind it are not stuck) and LockTimeoutError is thrown.
  async waitFor(previous, lockKey, releaseOwnTurn) {
    const startedMs = Date.now();
    let warnTimer;
    let giveUpTimer;
    const gaveUp = new Promise((resolve) => {
      warnTimer = setTimeout(() => {
        const logger = typeof this.logger === 'function' ? this.logger() : this.logger;
        logger?.warn?.(`[lock] waiting more than ${Math.round(this.warnAfterMs / 1000)} s for lockKey=${lockKey}`);
      }, this.warnAfterMs);
      giveUpTimer = setTimeout(() => resolve(true), this.timeoutMs);
      warnTimer.unref?.();
      giveUpTimer.unref?.();
    });
    try {
      const timedOut = await Promise.race([previous.then(() => false), gaveUp]);
      if (timedOut) {
        releaseOwnTurn();
        throw new LockTimeoutError(lockKey, Date.now() - startedMs);
      }
    } finally {
      clearTimeout(warnTimer);
      clearTimeout(giveUpTimer);
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
