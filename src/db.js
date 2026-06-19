import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Harden SQLite for local concurrent reads and short writer contention
try {
  db.pragma('journal_mode = WAL');
} catch (e) {
}

db.pragma('busy_timeout = 5000');

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
`);

let deterministicFailuresRemaining = Number(process.env.DB_FAIL_COUNT || 0);

// Simulate transient database failures for deterministic retry tests
function maybeFail() {
  if (deterministicFailuresRemaining > 0) {
    deterministicFailuresRemaining -= 1;
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }

  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// Keep inserts simple so uniqueness errors surface to the handler
export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const stmt = db.prepare(
    'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
  );
  return stmt.run(userId, type, String(payload), idemKey || null, nowMs);
}

// Lookup supports replay and unique-conflict recovery paths
export function getByIdemKey(idemKey) {
  maybeFail();
  const stmt = db.prepare(
    'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?'
  );
  return stmt.get(idemKey);
}

// Recent-user query stays covered by the user/time index
export function listSignals(userId, limit) {
  maybeFail();
  const stmt = db.prepare(
    'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(userId, limit);
}
