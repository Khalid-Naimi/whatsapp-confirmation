// A small gate: at most `limit` jobs run at the same time, the others wait their turn (first come, first served).
// A job that waits longer than `maxWaitMs` is not started: it fails with a TimeoutError, nothing was sent, so the
// caller may safely try again (the hourly run and the other retry loops treat a TimeoutError as transient).

export class Semaphore {
  constructor({ limit = 4, maxWaitMs = 60000 } = {}) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
    this.maxWaitMs = maxWaitMs;
    this.running = 0;
    this.waiting = [];
  }

  // Jobs running now and jobs waiting (for tests and health numbers).
  stats() {
    return { running: this.running, waiting: this.waiting.length };
  }

  async run(job, label = 'job') {
    await this.acquire(label);
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  acquire(label) {
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        const error = new Error(`${label} waited more than ${Math.round(this.maxWaitMs / 1000)} s for a free slot and was not started (timed out)`);
        error.name = 'TimeoutError';
        reject(error);
      }, this.maxWaitMs);
      entry.timer.unref?.();
      this.waiting.push(entry);
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // the slot passes straight to the next job
      return;
    }
    this.running -= 1;
  }
}
