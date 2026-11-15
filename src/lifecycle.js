// Start-up and shut-down helpers for server.js, kept apart so they can be tested without opening a port.

export const KEEP_AWAKE_INTERVAL_MS = 10 * 60 * 1000;
export const SHUTDOWN_GRACE_MS = 10 * 1000;

// The public address to ping, or '' when there is none worth pinging (unset or a local address).
export function keepAwakeUrl(env = process.env, baseUrl = '') {
  const raw = String(env.RENDER_EXTERNAL_URL || baseUrl || '').trim();
  if (!raw) {
    return '';
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0') {
    return '';
  }
  return new URL('/health', url).toString();
}

// Calls the service's own public /health every 10 minutes so a free instance is not spun down between orders.
// Returns a stop() function. Does nothing without a public address. The timer never keeps the process alive.
export function startKeepAwake({ url, intervalMs = KEEP_AWAKE_INTERVAL_MS, timeoutMs = 15000, fetchImpl = fetch, logger = console } = {}) {
  if (!url) {
    return () => {};
  }
  const ping = async () => {
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      if (!response?.ok) {
        logger.warn(`[keep-awake] health ping answered ${response?.status}`);
      }
    } catch (error) {
      logger.warn(`[keep-awake] health ping failed: ${error?.name || 'error'}`);
    }
  };
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  logger.log(`[keep-awake] pinging ${new URL(url).host}/health every ${Math.round(intervalMs / 60000)} min`);
  return () => clearInterval(timer);
}

// Stops taking new requests, gives running background work (HighDelivery sends, stock alerts) up to graceMs to end,
// then exits. Safe to call twice: the second call is ignored.
export function createShutdown({ server, waitFor = [], stop = [], graceMs = SHUTDOWN_GRACE_MS, logger = console, exit = (code) => process.exit(code) }) {
  let started = false;
  return async function shutdown(signal = 'SIGTERM') {
    if (started) {
      return;
    }
    started = true;
    logger.log(`[shutdown] ${signal} received: no new requests, waiting up to ${Math.round(graceMs / 1000)} s for running work`);
    for (const stopOne of stop) {
      try {
        stopOne();
      } catch {
        // stopping a timer cannot fail in a way that matters here
      }
    }
    const closed = new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
    const work = Promise.allSettled([closed, ...waitFor.map((get) => Promise.resolve().then(get))]);
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([work.then(() => 'done'), timedOut]);
    clearTimeout(timer);
    logger.log(outcome === 'done' ? '[shutdown] all work finished, exiting' : '[shutdown] grace time over, exiting with work still running');
    exit(0);
  };
}
