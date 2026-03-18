export class WasenderClient {
  constructor({
    baseUrl,
    apiToken,
    fetchImpl = fetch,
    minIntervalMs = 5000,
    maxRetries = 3,
    nowImpl = () => Date.now(),
    sleepImpl = sleep
  }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.apiToken = apiToken;
    this.fetch = fetchImpl;
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
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      await this.waitForAvailability();

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
        this.nextAvailableAt = this.now() + this.minIntervalMs;
        return data;
      }

      if (response.status === 429 && attempt < this.maxRetries) {
        const retryMs = resolveRetryDelayMs(data, this.minIntervalMs);
        this.nextAvailableAt = Math.max(this.nextAvailableAt, this.now() + retryMs);
        await this.sleep(retryMs);
        attempt += 1;
        continue;
      }

      throw new Error(`Wasender send-message failed with ${response.status}: ${JSON.stringify(data)}`);
    }

    throw new Error('Wasender send-message failed: retry limit reached');
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
