import { redact } from '../log.js';

// The one way the server calls another service (WooCommerce, WordPress, Wasender, HighDelivery).
//
// request({ method, url, headers, body, timeoutMs, retry, idempotent, ... }) -> { status, data, text, bodyFormat, headers }
// for a 2xx answer, otherwise it throws one HttpError:
//   kind 'timeout' (no answer in time), 'network' (no connection / dropped), 'http' (an answer with a non-2xx status);
//   status (0 without an answer); ambiguous (the request may have been carried out although we cannot tell: a write
//   with no answer, or a write answered with a 5xx); data / text / bodyFormat of the reply (never in the message).
//
// Retry policy (retry: 'safe'): GET/HEAD, and writes the caller marks `idempotent` (absolute values: a PUT of a stock
// quantity, a meta write), are retried on no answer, 429 and 5xx with exponential backoff and jitter. Other writes
// (POST of an order note, any create call) are never retried. retry: 'none' turns retries off.
// Every message (and every log line written here) goes through redact(): phones, emails, tokens, consumer keys,
// secret query values and the `secrets` handed in.

export class HttpError extends Error {
  constructor({ kind, status = 0, ambiguous = false, message, data = null, text = '', bodyFormat = '', retryAfterMs = 0 }) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.ambiguous = Boolean(ambiguous);
    this.data = data;
    this.text = text;
    this.bodyFormat = bodyFormat;
    this.retryAfterMs = retryAfterMs;
  }
}

export const RETRY_DEFAULTS = Object.freeze({ attempts: 3, baseDelayMs: 1000, maxDelayMs: 15000 });

const READS = new Set(['GET', 'HEAD']);

export function isRetryableError(error) {
  if (!(error instanceof HttpError)) {
    return false;
  }
  return error.kind !== 'http' || error.status === 429 || error.status >= 500;
}

// Exponential backoff (base, 2x base, 4x base ...) with +-25 % jitter, capped; a server's Retry-After wins.
export function backoffDelay(attempt, { baseDelayMs = RETRY_DEFAULTS.baseDelayMs, maxDelayMs = RETRY_DEFAULTS.maxDelayMs, random = Math.random, retryAfterMs = 0 } = {}) {
  if (retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxDelayMs * 4);
  }
  const plain = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.max(0, Math.round(plain * (0.75 + random() * 0.5)));
}

export async function request({
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs = 20000,
  retry = 'safe',
  idempotent = false,
  attempts = RETRY_DEFAULTS.attempts,
  baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
  maxDelayMs = RETRY_DEFAULTS.maxDelayMs,
  fetchImpl = fetch,
  sleep = defaultSleep,
  random = Math.random,
  secrets = [],
  label = 'request',
  onRetry = null
}) {
  const verb = String(method || 'GET').toUpperCase();
  const isRead = READS.has(verb);
  const mayRetry = retry === 'safe' && (isRead || idempotent);
  const maxAttempts = mayRetry ? Math.max(1, attempts) : 1;
  const finalHeaders = { ...headers };
  let payload = body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    if (!Object.keys(finalHeaders).some((name) => name.toLowerCase() === 'content-type')) {
      finalHeaders['Content-Type'] = 'application/json';
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await once({ verb, isRead, url, headers: finalHeaders, payload, timeoutMs, fetchImpl, secrets, label });
    } catch (error) {
      if (!(error instanceof HttpError) || attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      const delayMs = backoffDelay(attempt, { baseDelayMs, maxDelayMs, random, retryAfterMs: error.retryAfterMs });
      onRetry?.({ attempt, nextAttempt: attempt + 1, of: maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}

async function once({ verb, isRead, url, headers, payload, timeoutMs, fetchImpl, secrets, label }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: verb,
      headers,
      body: payload === undefined ? undefined : payload,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
    throw new HttpError({
      kind: timeout ? 'timeout' : 'network',
      status: 0,
      // A write that got no answer may still have been carried out.
      ambiguous: !isRead,
      message: redact(`${label} gave no answer (${timeout ? 'timeout' : `network error: ${error?.message || error?.name || 'unknown'}`})`, { secrets })
    });
  }

  const status = Number(response?.status) || (response?.ok ? 200 : 0);
  const ok = typeof response?.ok === 'boolean' ? response.ok : (status >= 200 && status < 300);
  const reply = await readReply(response);
  if (ok) {
    return { status, ...reply, headers: response?.headers || null };
  }
  throw new HttpError({
    kind: 'http',
    status,
    ambiguous: !isRead && status >= 500,
    message: redact(`${label} failed with ${status}`, { secrets }),
    retryAfterMs: retryAfterMs(response, reply.data),
    ...reply
  });
}

// { data, text, bodyFormat }: 'json', 'text' (not JSON), 'empty' or 'unreadable'.
async function readReply(response) {
  if (typeof response?.text === 'function') {
    let text;
    try {
      text = await response.text();
    } catch {
      return { data: null, text: '', bodyFormat: 'unreadable' };
    }
    if (!text) {
      return { data: null, text: '', bodyFormat: 'empty' };
    }
    try {
      return { data: JSON.parse(text), text, bodyFormat: 'json' };
    } catch {
      return { data: null, text, bodyFormat: 'text' };
    }
  }
  if (typeof response?.json === 'function') {
    try {
      const data = await response.json();
      return { data, text: '', bodyFormat: data === null || data === undefined ? 'empty' : 'json' };
    } catch {
      return { data: null, text: '', bodyFormat: 'unreadable' };
    }
  }
  return { data: null, text: '', bodyFormat: 'empty' };
}

function retryAfterMs(response, data) {
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('retry-after') : null;
  const seconds = Number(header ?? data?.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
