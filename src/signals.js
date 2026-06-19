import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs(){ return Date.now(); }

const MAX_DB_ATTEMPTS = Number(process.env.DB_RETRY_ATTEMPTS || 4);
const BASE_BACKOFF_MS = Number(process.env.DB_RETRY_BASE_MS || 25);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
  return err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_LOCKED';
}

function isUniqueConstraintError(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err?.code === 'SQLITE_CONSTRAINT' ||
    /UNIQUE constraint failed/i.test(err?.message || '');
}

function retryAfterSeconds(resetMs) {
  return String(Math.max(1, Math.ceil((resetMs - nowMs()) / 1000)));
}

function isIdempotencyMatch(existing, userId, type, payload) {
  return existing.userId === userId &&
    existing.type === type &&
    existing.payload === String(payload);
}

function sendIdempotencyConflict(reply) {
  return reply.code(409).send({ error: 'idempotency_conflict' });
}

// Retry transient database failures with bounded backoff
async function withDbRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_DB_ATTEMPTS; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientDbError(err) || attempt === MAX_DB_ATTEMPTS) {
        throw err;
      }

      lastErr = err;
      const exponential = BASE_BACKOFF_MS * (2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * BASE_BACKOFF_MS);
      await sleep(exponential + jitter);
    }
  }

  throw lastErr;
}

// Fast-path replay lookup for completed requests
async function getExistingByIdemKey(idem) {
  return withDbRetry(() => getByIdemKey(idem));
}

// Reject reuse of an idempotency key for a different request
function existingOrConflict(existing, userId, type, payload) {
  if (!existing) return null;
  if (!isIdempotencyMatch(existing, userId, type, payload)) {
    const err = new Error('idempotency_conflict');
    err.code = 'IDEMPOTENCY_CONFLICT';
    err.existing = existing;
    throw err;
  }
  return existing;
}

// Database uniqueness is the source of truth for idempotency
async function insertSignalAtomically(userId, type, payload, idem, t) {
  try {
    const info = await withDbRetry(() => insertSignal(userId, type, payload, idem, t));
    return {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: idem,
      createdAt: t
    };
  } catch (err) {
    if (!idem || !isUniqueConstraintError(err)) {
      throw err;
    }

    const existing = await getExistingByIdemKey(idem);
    if (existing) return existingOrConflict(existing, userId, type, payload);
    throw err;
  }
}

// Replays return before rate limiting so safe retries do not consume quota
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  try {
    if (idem) {
      const existing = await getExistingByIdemKey(idem);
      if (existing) return existingOrConflict(existing, userId, type, payload);
    }
  } catch (e) {
    if (e.code === 'IDEMPOTENCY_CONFLICT') {
      return sendIdempotencyConflict(reply);
    }
    req.log.error({ err: e, ctx: 'getByIdemKey' });
    return reply.header('Retry-After', '1').code(503).send({ error: 'db_unavailable' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) {
    return reply
      .header('Retry-After', retryAfterSeconds(resetMs))
      .code(429)
      .send({ error: 'rate_limited', remaining, resetMs });
  }

  try {
    const t = nowMs();
    return await insertSignalAtomically(userId, type, payload, idem, t);
  } catch (e) {
    if (e.code === 'IDEMPOTENCY_CONFLICT') {
      return sendIdempotencyConflict(reply);
    }
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.header('Retry-After', '1').code(503).send({ error: 'db_unavailable' });
  }
}

// List reads also retry transient database contention
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withDbRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.header('Retry-After', '1').code(503).send({ error: 'db_unavailable' });
  }
}
