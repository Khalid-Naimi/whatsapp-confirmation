import { HttpError, request as httpRequest } from '../http/request.js';
import { redact } from '../log.js';
import { maskPhone } from '../utils/format.js';

// The longest a routine team notice (low lane) waits behind customer messages.
export const LOW_LANE_MAX_WAIT_MS = 60 * 1000;

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
    sleepImpl = sleep,
    lowLaneMaxWaitMs = LOW_LANE_MAX_WAIT_MS
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
    // (priority 'low') only when no customer message is waiting, so a burst of alerts never delays a customer. A low
    // send never waits longer than lowLaneMaxWaitMs (60 s): then it goes next even with customer messages waiting.
    this.lanes = { normal: [], low: [] };
    this.lowLaneMaxWaitMs = lowLaneMaxWaitMs;
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
      this.lanes[lane].push({ job, resolve, reject, queuedAt: this.now() });
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
        const lowOverdue = this.lanes.low.length > 0 && this.now() - this.lanes.low[0].queuedAt >= this.lowLaneMaxWaitMs;
        const next = lowOverdue ? this.lanes.low.shift() : (this.lanes.normal.shift() || this.lanes.low.shift());
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

  // A send is a create call: the HTTP layer never repeats it by itself. Only a 429 (nothing was sent) is tried again
  // here, after Wasender's retry_after. No answer = ambiguous (the message may have gone out). Error texts carry the
  // status only, never the reply body or a phone; the reply stays on the error (`data`) for the contactability check.
  async sendMessageWithRetries({ to, message, poll }) {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      await this.waitForAvailability();
      this.logger.log(`[wasender] send attempt=${attempt + 1} to=${maskPhone(to)}`);

      let reply;
      try {
        reply = await httpRequest({
          method: 'POST',
          url: `${this.baseUrl}/send-message`,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify(poll ? { to, poll } : { to, text: message }),
          timeoutMs: this.timeoutMs,
          retry: 'none',
          fetchImpl: this.fetch,
          secrets: [this.apiToken],
          label: 'Wasender send-message'
        });
      } catch (error) {
        if (!(error instanceof HttpError) || error.kind !== 'http') {
          // No answer in time: the message may or may not have gone out. It is NOT safe to treat it as "not sent".
          this.logger.warn(`[wasender] send gave no answer to=${maskPhone(to)} reason=${error?.kind || error?.name || 'error'}`);
          throw new WasenderSendError({ status: 0, data: { timeout: true }, message: 'Wasender did not answer in time; the message may have been sent', ambiguous: true });
        }
        const data = error.data;
        this.logger.warn(`[wasender] send rejected to=${maskPhone(to)} status=${error.status}${describeReply(data)}`);
        if (error.status === 429 && attempt < this.maxRetries - 1) {
          const retryMs = resolveRetryDelayMs(data, this.minIntervalMs);
          this.nextAvailableAt = Math.max(this.nextAvailableAt, this.now() + retryMs);
          await this.sleep(retryMs);
          continue;
        }
        throw new WasenderSendError({ status: error.status, data, message: `Wasender send-message failed with ${error.status}` });
      }

      const data = reply.data;
      if (data?.success === false) {
        // Wasender answers 200 with success:false when the session is disconnected; nothing was sent.
        this.logger.warn(`[wasender] send rejected to=${maskPhone(to)} status=${reply.status}${describeReply(data)}`);
        throw new WasenderSendError({
          status: reply.status,
          data,
          message: 'Wasender send-message was not delivered (success: false)'
        });
      }

      this.logger.log(`[wasender] send accepted to=${maskPhone(to)} status=${reply.status}${describeReply(data)}`);
      this.nextAvailableAt = this.now() + this.minIntervalMs;
      return data;
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

// For the log: the message id and Wasender's own short message, redacted; never the echoed text or recipient.
function describeReply(data) {
  if (!data || typeof data !== 'object') {
    return '';
  }
  const parts = [];
  const id = data.data?.msgId ?? data.data?.id ?? data.msgId ?? data.id;
  if (id !== undefined && id !== null && ['string', 'number'].includes(typeof id)) {
    parts.push(`msgId=${String(id).slice(0, 64)}`);
  }
  if (typeof data.message === 'string' && data.message) {
    parts.push(`message=${JSON.stringify(redact(data.message).slice(0, 160))}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
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
