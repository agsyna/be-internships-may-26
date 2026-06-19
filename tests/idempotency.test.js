import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('health endpoint responds without authentication', async () => {
  const server = await startServer({ port: 9091 });
  try {
    const res = await requestJson('GET', `${server.base}/healthz`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    server.stop();
  }
});

test('idempotency returns same resource for duplicate replay', async () => {
  const server = await startServer({ port: 9092 });
  try {
    const idem = 'same-key';

    const a = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u1', type: 'note', payload: 'x' }
    });
    const b = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u1', type: 'note', payload: 'x' }
    });

    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(a.body.id, b.body.id);
    assert.equal(a.body.idempotencyKey, b.body.idempotencyKey);
  } finally {
    server.stop();
  }
});

test('same idempotency key with different request returns conflict', async () => {
  const server = await startServer({ port: 9096 });
  try {
    const cases = [
      ['conflict-payload', { userId: 'u1', type: 'note', payload: 'different' }],
      ['conflict-user', { userId: 'u2', type: 'note', payload: 'x' }],
      ['conflict-type', { userId: 'u1', type: 'alert', payload: 'x' }]
    ];

    for (const [idem, changedBody] of cases) {
      const first = await postJson(`${server.base}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: { userId: 'u1', type: 'note', payload: 'x' }
      });
      const conflict = await postJson(`${server.base}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: changedBody
      });

      assert.equal(first.statusCode, 200);
      assert.equal(conflict.statusCode, 409);
      assert.deepEqual(conflict.body, { error: 'idempotency_conflict' });
    }
  } finally {
    server.stop();
  }
});

// Proves the unique constraint protects the race where every request misses lookup
test('concurrent idempotent requests create exactly one row', async () => {
  const server = await startServer({
    port: 9093,
    env: { RATE_LIMIT_PER_MIN: '100' }
  });
  try {
    const idem = 'parallel-key';
    const requests = Array.from({ length: 25 }, () =>
      postJson(`${server.base}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: { userId: 'u-concurrent', type: 'note', payload: 'x' }
      })
    );

    const responses = await Promise.all(requests);
    const ids = new Set(responses.map((res) => res.body.id));

    assert.deepEqual(new Set(responses.map((res) => res.statusCode)), new Set([200]));
    assert.equal(ids.size, 1);

    const db = new Database(server.dbPath);
    try {
      const row = db.prepare(
        'SELECT COUNT(*) as count FROM signals WHERE idempotency_key = ?'
      ).get(idem);
      assert.equal(row.count, 1);
    } finally {
      db.close();
    }
  } finally {
    server.stop();
  }
});

// Proves retries preserve idempotency under transient database failures
test('transient insert failures are retried without duplicate creation', async () => {
  const server = await startServer({
    port: 9094,
    env: { DB_FAIL_COUNT: '2', DB_RETRY_BASE_MS: '1' }
  });
  try {
    const idem = 'retry-key';
    const res = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u-retry', type: 'note', payload: 'x' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.idempotencyKey, idem);

    const replay = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u-retry', type: 'note', payload: 'x' }
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.id, res.body.id);

    const db = new Database(server.dbPath);
    try {
      const row = db.prepare(
        'SELECT COUNT(*) as count FROM signals WHERE idempotency_key = ?'
      ).get(idem);
      assert.equal(row.count, 1);
    } finally {
      db.close();
    }
  } finally {
    server.stop();
  }
});

test('invalid request body returns 400', async () => {
  const server = await startServer({ port: 9097 });
  try {
    const res = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-invalid', payload: 'missing type' }
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'invalid_body' });
  } finally {
    server.stop();
  }
});

test('unauthorized request returns 401', async () => {
  const server = await startServer({ port: 9098 });
  try {
    const res = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'wrong' },
      body: { userId: 'u-auth', type: 'note', payload: 'x' }
    });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  } finally {
    server.stop();
  }
});

test('retry exhaustion returns 503 with retry-after', async () => {
  const server = await startServer({
    port: 9099,
    env: { DB_FAIL_COUNT: '10', DB_RETRY_ATTEMPTS: '2', DB_RETRY_BASE_MS: '1' }
  });
  try {
    const res = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'exhaust-key' },
      body: { userId: 'u-exhaust', type: 'note', payload: 'x' }
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '1');
    assert.deepEqual(res.body, { error: 'db_unavailable' });
  } finally {
    server.stop();
  }
});

test('signals can be retrieved for a user', async () => {
  const server = await startServer({ port: 9095 });
  try {
    const created = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-list', type: 'note', payload: 'hello' }
    });
    assert.equal(created.statusCode, 200);

    const listed = await requestJson('GET', `${server.base}/v1/signals?userId=u-list&limit=10`, {
      'x-api-key': 'k'
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, created.body.id);
  } finally {
    server.stop();
  }
});

async function startServer({ port, env = {} }) {
  const dbPath = path.join(os.tmpdir(), `signals-${process.pid}-${port}-${Date.now()}.db`);
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(port),
      DATABASE_URL: dbPath,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, proc, () => stderr);

  return {
    base,
    dbPath,
    stop() {
      proc.kill();
    }
  };
}

async function waitForServer(base, proc, getStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited before startup: ${getStderr()}`);
    }

    try {
      const res = await requestJson('GET', `${base}/healthz`);
      if (res.statusCode === 200) return;
    } catch (e) {
      await wait(50);
    }
  }

  throw new Error(`server did not start: ${getStderr()}`);
}

async function postJson(url, { headers, body }) {
  return requestJson('POST', url, headers, body);
}

async function requestJson(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json' } : {}),
        ...headers
      }
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: JSON.parse(chunks || '{}')
        });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
