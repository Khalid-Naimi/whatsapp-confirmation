import { randomBytes } from 'node:crypto';

// Cross-instance guard for one action on one WooCommerce record (a customer WhatsApp message, a HighDelivery parcel,
// the durable server records). Production runs one instance, but during a deploy the old and the new one overlap for
// a while; the in-memory locks only protect one process. The claim lives in the record's own meta:
//
//   1. read the record (or take the one the caller just read) and refuse when someone else holds a live claim, or when
//      the caller's own check says the work is already done;
//   2. write { state, claimId, at } (together with the caller's own reservation rows, one write);
//   3. wait a moment (settleMs, 1 s by default) so a competing write that started at the same time has landed;
//   4. read again and go on only if our claimId is still there (last writer wins, the other one backs off).
//
// A claim that has disappeared on the re-read (released by its holder, or a WooCommerce that did not keep it) is not
// someone else's claim: the caller goes on. A re-read that fails also lets the caller go on (one instance is the
// normal case; the caller's own reservation state stays the guard), with a warning.

export const DEFAULT_CLAIM_SETTLE_MS = 1000;

// Random per process: no host name or other machine detail goes into the shop's data.
export const INSTANCE_ID = `srv-${process.pid}-${randomBytes(4).toString('hex')}`;

export function parseClaim(value) {
  if (!value) {
    return null;
  }
  try {
    const data = JSON.parse(String(value));
    if (!data || typeof data !== 'object' || !data.claimId) {
      return null;
    }
    return { state: String(data.state || ''), claimId: String(data.claimId), at: String(data.at || '') };
  } catch {
    return null;
  }
}

export function isLiveClaim(existing, nowMs, ttlMs) {
  if (!existing) {
    return false;
  }
  const atMs = Date.parse(existing.at);
  return !Number.isNaN(atMs) && nowMs - atMs < ttlMs;
}

function readMetaValue(record, key) {
  const row = (Array.isArray(record?.meta_data) ? record.meta_data : []).find((item) => item?.key === key);
  return row ? row.value : '';
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The generic form: `read()` returns the record (with meta_data), `write(rows)` writes meta rows to it.
export async function claimRecord({
  read = null,
  write,
  key,
  label = key,
  ttlMs = 10 * 60 * 1000,
  state = 'claimed',
  settleMs = DEFAULT_CLAIM_SETTLE_MS,
  sleep = defaultSleep,
  now = () => new Date(),
  instanceId = INSTANCE_ID,
  current = null,
  fallback = null,
  check = null,
  extraMeta = [],
  logger = console
}) {
  let record = current;
  if (!record && read) {
    try {
      record = await read();
    } catch (error) {
      logger.warn(`[claim] ${label}: could not read before claiming (${error.message}); going on with the data at hand`);
      record = fallback;
    }
  }
  record = record || fallback || null;

  const refusal = check ? check(record) : '';
  if (refusal) {
    return { ok: false, reason: refusal, order: record };
  }
  const existing = parseClaim(readMetaValue(record, key));
  if (isLiveClaim(existing, now().getTime(), ttlMs) && !existing.claimId.startsWith(`${instanceId}:`)) {
    return { ok: false, reason: 'held', holder: existing, order: record };
  }

  const claimId = `${instanceId}:${randomBytes(6).toString('hex')}`;
  const value = JSON.stringify({ state, claimId, at: now().toISOString() });
  const rows = typeof extraMeta === 'function' ? extraMeta(record) : extraMeta;
  const written = await write([...(rows || []), { key, value }]);

  const release = (releaseRows = []) => write([...(releaseRows || []), { key, value: '' }]);

  if (!read) {
    return { ok: true, claimId, order: written || record, written, verified: false, release };
  }
  if (settleMs > 0) {
    await sleep(settleMs);
  }
  let reread;
  try {
    reread = await read();
  } catch (error) {
    logger.warn(`[claim] ${label}: could not read the claim back (${error.message}); going on`);
    return { ok: true, claimId, order: written || record, written, verified: false, release };
  }
  const holder = parseClaim(readMetaValue(reread, key));
  if (holder && holder.claimId !== claimId) {
    logger.warn(`[claim] ${label}: another instance claimed it at the same time (${holder.claimId}); backing off`);
    return { ok: false, reason: 'lost', holder, order: reread, written };
  }
  return { ok: true, claimId, order: reread || written || record, written, verified: true, release };
}

// Claims `key` in the meta of WooCommerce order `orderId`. Returns { ok: true, claimId, order, written, release } or
// { ok: false, reason: 'held' | 'lost' | <the check's reason>, holder, order }. A failed claim write throws.
export async function claim(wooClient, orderId, key, options = {}) {
  const id = String(orderId);
  const canRead = typeof wooClient?.getOrder === 'function';
  return claimRecord({
    ...options,
    key,
    label: options.label || `order ${id} ${key}`,
    read: canRead ? () => wooClient.getOrder(id) : null,
    write: (rows) => wooClient.updateOrderMeta(id, rows)
  });
}
