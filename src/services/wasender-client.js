export class WasenderClient {
  constructor({
    baseUrl,
    apiToken,
    fetchImpl = fetch,
    logger = console,
    minIntervalMs = 5000,
    maxRetries = 3,
    nowImpl = () => Date.now(),
    sleepImpl = sleep
  }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.apiToken = apiToken;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.now = nowImpl;
    this.sleep = sleepImpl;
    this.sendChain = Promise.resolve();
    this.nextAvailableAt = 0;
  }

  async sendMessage({ to, message }) {
    const run = this.sendChain.then(() => this.sendMessageWithRetries({ to, message }));
    this.sendChain = run.catch(() => {});
    return run;
  }

  async sendMessageWithRetries({ to, message }) {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      await this.waitForAvailability();
      this.logger.log(`[wasender] send attempt=${attempt + 1} to=${maskPhone(to)}`);

      const response = await this.fetch(`${this.baseUrl}/send-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`
        },
        body: JSON.stringify({
          to,
          text: message
        })
      });

      const data = await parseJsonSafe(response);
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

function maskPhone(value) {
  const input = String(value || '');
  if (input.length <= 4) {
    return input;
  }

  return `${input.slice(0, 4)}***${input.slice(-2)}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

export class WasenderSendError extends Error {
  constructor({ status, data, message }) {
    super(message);
    this.name = 'WasenderSendError';
    this.status = status;
    this.data = data;
  }
}
