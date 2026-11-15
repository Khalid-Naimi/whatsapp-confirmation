import { maskEmail, maskPhone } from './utils/format.js';

// One place that hides what must never reach a log line, an error text or a team message: phone numbers, emails,
// bearer/basic tokens, WooCommerce consumer keys, secret query values and any secret value handed in.

const SECRET_QUERY_KEYS = 'consumer_key|consumer_secret|token|access_token|api_key|apikey|api_token|key|secret|password|signature|auth';
const SECRET_JSON_KEYS = 'password|pass|token|api_token|apiToken|apiKey|api_key|secret|consumer_key|consumer_secret|authorization';

export function redact(input, { secrets = [] } = {}) {
  let text = String(input ?? '');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value.length >= 4) {
      text = text.split(value).join('[redacted]');
    }
  }
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, '$1 [redacted]')
    .replace(new RegExp(`([?&](?:${SECRET_QUERY_KEYS})=)[^&#\\s"']*`, 'giu'), '$1[redacted]')
    .replace(new RegExp(`("(?:${SECRET_JSON_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'giu'), '$1"[redacted]"')
    .replace(/\b(ck|cs)_[A-Za-z0-9]{8,}/gu, '$1_[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, (match) => maskEmail(match))
    // +212 6 12-34-56-78 style (needs the plus, so dates such as 2026-11-15 are left alone)
    .replace(/\+\d{1,3}(?:[\s().-]*\d){7,13}/gu, (match) => maskPhone(match.replace(/[^\d+]/gu, '')))
    .replace(/(?<![\w*])\+?\d{9,15}(?!\d)/gu, (match) => maskPhone(match));
}

let sink = console;

// Where log() writes (a logger with log/warn/error). Tests point it at an array.
export function setLogSink(logger) {
  const previous = sink;
  sink = logger || console;
  return previous;
}

// One JSON line per event: {"at":..., "level":..., "event":..., ...fields}, always passed through redact().
// Use it for anything that may carry customer data or a provider's answer.
export function log(level, event, fields = {}, { logger = sink, now = () => new Date() } = {}) {
  let line;
  try {
    line = JSON.stringify({ at: now().toISOString(), level, event, ...fields });
  } catch {
    line = JSON.stringify({ at: now().toISOString(), level, event, note: 'fields could not be serialized' });
  }
  const text = redact(line);
  const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log');
  (logger?.[method] || logger?.log || console.log).call(logger, text);
  return text;
}
