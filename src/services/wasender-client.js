import { maskPhone, redactPhones } from '../utils/format.js';

export class WasenderClient {
  constructor({
    baseUrl,
    apiToken,
    fetchImpl = fetch,
    logger = console,
    minIntervalMs = 5000,
    maxRetries = 3,
    timeoutMs = 20000,
    nowImpl = () => Date.now(),
    sleepImpl = sleep
  }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.apiToken = apiToken;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.now = nowImpl;
    this.sleep = sleepImpl;
    this.nextAvailableAt = 0;
    // One send at a time (the account is rate limited). Two lanes: customer messages first, routine team notices
    // (priority 'low') only when no customer message is waiting, so a burst of alerts never delays a customer.
    this.lanes = { normal: [], low: [] };
    this.pumping = false;
  }

  async sendMessage({ to, message, priority = 'normal' }) {
    return this.enqueue(() => this.sendMessageWithRetries({ to, message }), priority);
  }

  async sendPoll({ to, question, options }) {
    return this.enqueue(() => this.sendMessageWithRetries({ to, poll: { question, options, multiSelect: false } }), 'normal');
  }

  // Number of sends waiting per lane (for tests and logs).
  queued() {
    return { normal: this.lanes.normal.length, low: this.lanes.low.length };
  }

  enqueue(job, priority) {
    const lane = priority === 'low' ? 'low' : 'normal';
    return new Promise((resolve, reject) => {
      this.lanes[lane].push({ job, resolve, reject });
      this.pump();
    });
  }

  async pump() {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const next = this.lanes.normal.shift() || this.lanes.low.shift();
        if (!next) {
          return;
        }
        try {
          next.resolve(await next.job());
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  async sendMessageWithRetries({ to, message, poll }) {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      await this.waitForAvailability();
      this.logger.log(`[wasender] send attempt=${attempt + 1} to=${maskPhone(to)}`);

      let response;
      try {
        response = await this.fetch(`${this.baseUrl}/send-message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiToken}`
          },
          body: JSON.stringify(poll ? { to, poll } : { to, text: message }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        // No answer in time: the message may or may not have gone out. It is NOT safe to treat it as "not sent".
        this.logger.warn(`[wasender] send gave no answer to=${maskPhone(to)} reason=${error?.name || 'error'}`);
        throw new WasenderSendError({ status: 0, data: { timeout: true }, message: 'Wasender did not answer in time; the message may have been sent', ambiguous: true });
      }

      const data = await parseJsonSafe(response);
      if (response.ok && data?.success === false) {
        // Wasender answers 200 with success:false when the session is disconnected; nothing was sent.
        this.logger.warn(`[wasender] send rejected to=${maskPhone(to)} status=${response.status} body=${safeJson(data)}`);
        throw new WasenderSendError({
          status: response.status,
          data,
          message: `Wasender send-message was not delivered: ${JSON.stringify(data)}`
        });
      }

      if (response.ok) {
        this.logger.log(`[wasender] send accepted to=${maskPhone(to)} status=${response.status} body=${safeJson(data)}`);
        this.nextAvailableAt = this.now() + this.minIntervalMs;
        return data;
      }

      this.logger.warn(`[wasender] send rejected to=${maskPhone(to)} status=${response.status} body=${safeJson(data)}`);

      if (response.status === 429 && attempt < this.maxRetries - 1) {
        const retryMs = resolveRetryDelayMs(data, this.minIntervalMs);
        this.nextAvailableAt = Math.max(this.nextAvailableAt, this.now() + retryMs);
        await this.sleep(retryMs);
        continue;
      }

      throw new WasenderSendError({
        status: response.status,
        data,
        message: `Wasender send-message failed with ${response.status}: ${JSON.stringify(data)}`
      });
    }

    throw new WasenderSendError({
      status: 429,
      data: null,
      message: 'Wasender send-message exhausted retry attempts without a successful response'
    });
  }

  async waitForAvailability() {
    const delayMs = this.nextAvailableAt - this.now();
    if (delayMs > 0) {
      await this.sleep(delayMs);
    }
  }
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function resolveRetryDelayMs(data, fallbackMs) {
  const retryAfterSeconds = Number(data?.retry_after);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return fallbackMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(value) {
  try {
    return redactPhones(JSON.stringify(value));
  } catch {
    return '"[unserializable]"';
  }
}

export class WasenderSendError extends Error {
  constructor({ status, data, message, ambiguous = false }) {
    super(message);
    this.name = 'WasenderSendError';
    this.status = status;
    this.data = data;
    this.ambiguous = Boolean(ambiguous);
  }
}
