import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('rate limit: allow 5 per minute, 6th is 429', async () => {
  const server = await startServer({
    port: 9101,
    env: { RATE_LIMIT_PER_MIN: '5' }
  });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await postJson(`${server.base}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u1', type: 'note', payload: String(i) }
      });
      statuses.push(res.statusCode);
    }

    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);

    const limited = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u1', type: 'note', payload: 'extra' }
    });
    assert.equal(limited.statusCode, 429);
    assert.match(limited.headers['retry-after'], /^[1-9]\d*$/);
  } finally {
    server.stop();
  }
});

test('idempotent replay does not consume rate limit quota', async () => {
  const server = await startServer({
    port: 9102,
    env: { RATE_LIMIT_PER_MIN: '1' }
  });
  try {
    const idem = 'rate-replay-key';
    const first = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u-replay', type: 'note', payload: 'x' }
    });
    const replay = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u-replay', type: 'note', payload: 'x' }
    });
    const newRequest = await postJson(`${server.base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-replay', type: 'note', payload: 'y' }
    });

    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(newRequest.statusCode, 429);
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
