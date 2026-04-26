import crypto from 'node:crypto';
import { Pool } from 'pg';

const DEFAULT_LOCK_TTL_SECONDS = 60;
const DEFAULT_OUTBOUND_REPAIR_BATCH_SIZE = 100;

export class WorkflowRepository {
  constructor({
    connectionString,
    lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
    outboundRepairBatchSize = DEFAULT_OUTBOUND_REPAIR_BATCH_SIZE,
    logger = console,
    ownerId = crypto.randomUUID(),
    pool = null
  }) {
    if (!connectionString && !pool) {
      throw new Error('WorkflowRepository requires a PostgreSQL connection string');
    }

    this.logger = logger;
    this.ownerId = ownerId;
    this.lockTtlSeconds = lockTtlSeconds;
    this.outboundRepairBatchSize = outboundRepairBatchSize;
    this.pool = pool || new Pool({ connectionString });
    this.ownsPool = !pool;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_locks (
        lock_key text PRIMARY KEY,
        owner_id text NOT NULL,
        lease_until timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS processed_events (
        source text NOT NULL,
        event_key text NOT NULL,
        status text NOT NULL,
        order_id text NULL,
        payload_hash text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source, event_key)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS outbound_messages (
        order_id text NOT NULL,
        logical_key text NOT NULL,
        recipient_phone text NOT NULL,
        state text NOT NULL,
        provider_message_id text NULL,
        accepted_at timestamptz NULL,
        persisted_at timestamptz NULL,
        lease_until timestamptz NULL,
        attempt_count integer NOT NULL DEFAULT 0,
        last_error text NULL,
        message_body text NULL,
        provider_payload_json text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (order_id, logical_key)
      )
    `);
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async acquireLock(lockKey, { ttlSeconds = this.lockTtlSeconds } = {}) {
    const result = await this.pool.query(
      `
        INSERT INTO workflow_locks (lock_key, owner_id, lease_until)
        VALUES ($1, $2, now() + make_interval(secs => $3))
        ON CONFLICT (lock_key) DO UPDATE
          SET owner_id = EXCLUDED.owner_id,
              lease_until = EXCLUDED.lease_until,
              updated_at = now()
        WHERE workflow_locks.lease_until <= now()
           OR workflow_locks.owner_id = EXCLUDED.owner_id
        RETURNING lock_key, owner_id, lease_until, created_at, updated_at
      `,
      [lockKey, this.ownerId, ttlSeconds]
    );

    if (!result.rows.length) {
      return { acquired: false, lockKey };
    }

    return {
      acquired: true,
      lockKey,
      ownerId: result.rows[0].owner_id,
      leaseUntil: result.rows[0].lease_until
    };
  }

  async releaseLock(lockKey) {
    await this.pool.query(
      'DELETE FROM workflow_locks WHERE lock_key = $1 AND owner_id = $2',
      [lockKey, this.ownerId]
    );
  }

  async reserveEvent({ source, eventKey, orderId = null, payloadHash = null }) {
    const insertResult = await this.pool.query(
      `
        INSERT INTO processed_events (source, event_key, status, order_id, payload_hash)
        VALUES ($1, $2, 'processing', $3, $4)
        ON CONFLICT (source, event_key) DO NOTHING
        RETURNING source, event_key, status, order_id, payload_hash, created_at, updated_at
      `,
      [source, eventKey, orderId, payloadHash]
    );

    if (insertResult.rows.length) {
      return { status: 'reserved', record: normalizeProcessedEventRow(insertResult.rows[0]) };
    }

    const existingResult = await this.pool.query(
      `
        SELECT source, event_key, status, order_id, payload_hash, created_at, updated_at
        FROM processed_events
        WHERE source = $1 AND event_key = $2
      `,
      [source, eventKey]
    );

    return {
      status: 'existing',
      record: existingResult.rows[0] ? normalizeProcessedEventRow(existingResult.rows[0]) : null
    };
  }

  async markEventStatus({ source, eventKey, status, orderId = null, payloadHash = null }) {
    const result = await this.pool.query(
      `
        UPDATE processed_events
        SET status = $3,
            order_id = COALESCE($4, order_id),
            payload_hash = COALESCE($5, payload_hash),
            updated_at = now()
        WHERE source = $1 AND event_key = $2
        RETURNING source, event_key, status, order_id, payload_hash, created_at, updated_at
      `,
      [source, eventKey, status, orderId, payloadHash]
    );

    return result.rows[0] ? normalizeProcessedEventRow(result.rows[0]) : null;
  }

  async reserveOutboundMessage({
    orderId,
    logicalKey,
    recipientPhone,
    messageBody,
    leaseSeconds = this.lockTtlSeconds
  }) {
    const insertResult = await this.pool.query(
      `
        INSERT INTO outbound_messages (
          order_id,
          logical_key,
          recipient_phone,
          state,
          lease_until,
          attempt_count,
          message_body
        )
        VALUES ($1, $2, $3, 'reserved', now() + make_interval(secs => $4), 0, $5)
        ON CONFLICT (order_id, logical_key) DO NOTHING
        RETURNING *
      `,
      [orderId, logicalKey, recipientPhone, leaseSeconds, messageBody]
    );

    if (insertResult.rows.length) {
      return { status: 'reserved', record: normalizeOutboundRow(insertResult.rows[0]) };
    }

    const existing = await this.getOutboundMessage(orderId, logicalKey);
    if (!existing) {
      return { status: 'missing', record: null };
    }

    if (existing.state === 'send_accepted' || existing.state === 'persisted') {
      return { status: existing.state, record: existing };
    }

    const leaseUntil = existing.leaseUntil ? Date.parse(existing.leaseUntil) : 0;
    if (existing.state === 'reserved' && leaseUntil > Date.now()) {
      return { status: 'in_progress', record: existing };
    }

    const updateResult = await this.pool.query(
      `
        UPDATE outbound_messages
        SET recipient_phone = $3,
            message_body = $4,
            state = 'reserved',
            lease_until = now() + make_interval(secs => $5),
            attempt_count = attempt_count + 1,
            last_error = NULL,
            updated_at = now()
        WHERE order_id = $1 AND logical_key = $2
        RETURNING *
      `,
      [orderId, logicalKey, recipientPhone, messageBody, leaseSeconds]
    );

    return {
      status: 'reserved',
      record: normalizeOutboundRow(updateResult.rows[0])
    };
  }

  async markOutboundAccepted({ orderId, logicalKey, providerMessageId = '', acceptedAt, providerPayload }) {
    const result = await this.pool.query(
      `
        UPDATE outbound_messages
        SET state = 'send_accepted',
            provider_message_id = $3,
            accepted_at = COALESCE($4, accepted_at, now()),
            provider_payload_json = $5,
            lease_until = NULL,
            updated_at = now()
        WHERE order_id = $1 AND logical_key = $2
        RETURNING *
      `,
      [orderId, logicalKey, providerMessageId || '', acceptedAt || null, safeJson(providerPayload)]
    );

    return result.rows[0] ? normalizeOutboundRow(result.rows[0]) : null;
  }

  async markOutboundPersisted({ orderId, logicalKey }) {
    const result = await this.pool.query(
      `
        UPDATE outbound_messages
        SET state = 'persisted',
            persisted_at = COALESCE(persisted_at, now()),
            lease_until = NULL,
            updated_at = now()
        WHERE order_id = $1 AND logical_key = $2
        RETURNING *
      `,
      [orderId, logicalKey]
    );

    return result.rows[0] ? normalizeOutboundRow(result.rows[0]) : null;
  }

  async markOutboundFailed({ orderId, logicalKey, error }) {
    const result = await this.pool.query(
      `
        UPDATE outbound_messages
        SET state = 'failed',
            last_error = $3,
            lease_until = NULL,
            updated_at = now()
        WHERE order_id = $1 AND logical_key = $2
        RETURNING *
      `,
      [orderId, logicalKey, String(error || '')]
    );

    return result.rows[0] ? normalizeOutboundRow(result.rows[0]) : null;
  }

  async getOutboundMessage(orderId, logicalKey) {
    const result = await this.pool.query(
      'SELECT * FROM outbound_messages WHERE order_id = $1 AND logical_key = $2',
      [orderId, logicalKey]
    );

    return result.rows[0] ? normalizeOutboundRow(result.rows[0]) : null;
  }

  async listRepairableOutboundMessages({ limit = this.outboundRepairBatchSize } = {}) {
    const result = await this.pool.query(
      `
        SELECT *
        FROM outbound_messages
        WHERE state = 'send_accepted' AND persisted_at IS NULL
        ORDER BY accepted_at NULLS FIRST, created_at ASC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(normalizeOutboundRow);
  }
}

export class InMemoryWorkflowRepository {
  constructor({
    lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
    outboundRepairBatchSize = DEFAULT_OUTBOUND_REPAIR_BATCH_SIZE,
    ownerId = 'test-owner'
  } = {}) {
    this.lockTtlSeconds = lockTtlSeconds;
    this.outboundRepairBatchSize = outboundRepairBatchSize;
    this.ownerId = ownerId;
    this.locks = new Map();
    this.events = new Map();
    this.outbound = new Map();
  }

  async init() {}

  async close() {}

  async acquireLock(lockKey, { ttlSeconds = this.lockTtlSeconds } = {}) {
    const existing = this.locks.get(lockKey);
    const now = Date.now();
    if (existing && existing.leaseUntil > now && existing.ownerId !== this.ownerId) {
      return { acquired: false, lockKey };
    }

    const leaseUntil = now + (ttlSeconds * 1000);
    this.locks.set(lockKey, { ownerId: this.ownerId, leaseUntil });
    return {
      acquired: true,
      lockKey,
      ownerId: this.ownerId,
      leaseUntil: new Date(leaseUntil).toISOString()
    };
  }

  async releaseLock(lockKey) {
    const existing = this.locks.get(lockKey);
    if (existing?.ownerId === this.ownerId) {
      this.locks.delete(lockKey);
    }
  }

  async reserveEvent({ source, eventKey, orderId = null, payloadHash = null }) {
    const mapKey = `${source}:${eventKey}`;
    if (this.events.has(mapKey)) {
      return { status: 'existing', record: this.events.get(mapKey) };
    }

    const record = {
      source,
      eventKey,
      status: 'processing',
      orderId,
      payloadHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.events.set(mapKey, record);
    return { status: 'reserved', record };
  }

  async markEventStatus({ source, eventKey, status, orderId = null, payloadHash = null }) {
    const mapKey = `${source}:${eventKey}`;
    const existing = this.events.get(mapKey);
    if (!existing) {
      return null;
    }

    const nextRecord = {
      ...existing,
      status,
      orderId: orderId ?? existing.orderId,
      payloadHash: payloadHash ?? existing.payloadHash,
      updatedAt: new Date().toISOString()
    };
    this.events.set(mapKey, nextRecord);
    return nextRecord;
  }

  async reserveOutboundMessage({ orderId, logicalKey, recipientPhone, messageBody, leaseSeconds = this.lockTtlSeconds }) {
    const mapKey = `${orderId}:${logicalKey}`;
    const existing = this.outbound.get(mapKey);
    const now = Date.now();

    if (!existing) {
      const record = {
        orderId,
        logicalKey,
        recipientPhone,
        state: 'reserved',
        providerMessageId: '',
        acceptedAt: '',
        persistedAt: '',
        leaseUntil: new Date(now + (leaseSeconds * 1000)).toISOString(),
        attemptCount: 0,
        lastError: '',
        messageBody,
        providerPayloadJson: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.outbound.set(mapKey, record);
      return { status: 'reserved', record };
    }

    if (existing.state === 'send_accepted' || existing.state === 'persisted') {
      return { status: existing.state, record: existing };
    }

    if (existing.state === 'reserved' && Date.parse(existing.leaseUntil || '') > now) {
      return { status: 'in_progress', record: existing };
    }

    const record = {
      ...existing,
      recipientPhone,
      state: 'reserved',
      leaseUntil: new Date(now + (leaseSeconds * 1000)).toISOString(),
      attemptCount: Number(existing.attemptCount || 0) + 1,
      lastError: '',
      messageBody,
      updatedAt: new Date().toISOString()
    };
    this.outbound.set(mapKey, record);
    return { status: 'reserved', record };
  }

  async markOutboundAccepted({ orderId, logicalKey, providerMessageId = '', acceptedAt, providerPayload }) {
    const mapKey = `${orderId}:${logicalKey}`;
    const existing = this.outbound.get(mapKey);
    if (!existing) {
      return null;
    }

    const record = {
      ...existing,
      state: 'send_accepted',
      providerMessageId: providerMessageId || '',
      acceptedAt: acceptedAt || new Date().toISOString(),
      providerPayloadJson: safeJson(providerPayload),
      leaseUntil: '',
      updatedAt: new Date().toISOString()
    };
    this.outbound.set(mapKey, record);
    return record;
  }

  async markOutboundPersisted({ orderId, logicalKey }) {
    const mapKey = `${orderId}:${logicalKey}`;
    const existing = this.outbound.get(mapKey);
    if (!existing) {
      return null;
    }

    const record = {
      ...existing,
      state: 'persisted',
      persistedAt: existing.persistedAt || new Date().toISOString(),
      leaseUntil: '',
      updatedAt: new Date().toISOString()
    };
    this.outbound.set(mapKey, record);
    return record;
  }

  async markOutboundFailed({ orderId, logicalKey, error }) {
    const mapKey = `${orderId}:${logicalKey}`;
    const existing = this.outbound.get(mapKey);
    if (!existing) {
      return null;
    }

    const record = {
      ...existing,
      state: 'failed',
      lastError: String(error || ''),
      leaseUntil: '',
      updatedAt: new Date().toISOString()
    };
    this.outbound.set(mapKey, record);
    return record;
  }

  async getOutboundMessage(orderId, logicalKey) {
    return this.outbound.get(`${orderId}:${logicalKey}`) || null;
  }

  async listRepairableOutboundMessages({ limit = this.outboundRepairBatchSize } = {}) {
    return [...this.outbound.values()]
      .filter((record) => record.state === 'send_accepted' && !record.persistedAt)
      .sort((left, right) => {
        const leftTime = Date.parse(left.acceptedAt || left.createdAt || '') || 0;
        const rightTime = Date.parse(right.acceptedAt || right.createdAt || '') || 0;
        return leftTime - rightTime;
      })
      .slice(0, limit);
  }
}

function normalizeProcessedEventRow(row) {
  return {
    source: row.source,
    eventKey: row.event_key,
    status: row.status,
    orderId: row.order_id,
    payloadHash: row.payload_hash,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '')
  };
}

function normalizeOutboundRow(row) {
  return {
    orderId: row.order_id,
    logicalKey: row.logical_key,
    recipientPhone: row.recipient_phone,
    state: row.state,
    providerMessageId: row.provider_message_id || '',
    acceptedAt: toIsoString(row.accepted_at),
    persistedAt: toIsoString(row.persisted_at),
    leaseUntil: toIsoString(row.lease_until),
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || '',
    messageBody: row.message_body || '',
    providerPayloadJson: row.provider_payload_json || '',
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function toIsoString(value) {
  if (!value) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return String(value || '');
}

function safeJson(value) {
  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}
