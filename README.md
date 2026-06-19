# Signals Challenge

Minimal Fastify service for ingesting user signals with API-key auth,
idempotent writes, per-user rate limiting, and bounded retry handling for
transient database failures.

## Endpoints

- `GET /healthz`
- `POST /v1/signals`
- `GET /v1/signals?userId=...&limit=...`

`POST /v1/signals` body:

```json
{
  "userId": "string",
  "type": "string",
  "payload": "string"
}
```

Headers:

- `X-API-Key`: required except for `/healthz`
- `Idempotency-Key`: optional

Common error responses include `400 invalid_body`, `401 unauthorized`,
`409 idempotency_conflict`, `429 rate_limited`, and `503 db_unavailable`.

## Architecture overview

- Fastify handles HTTP routing and authentication.
- SQLite stores signals durably for the assignment.
- `UNIQUE(idempotency_key)` is the correctness boundary for idempotent writes.
- An in-memory limiter enforces per-user limits in a single process.
- Database calls retry bounded transient failures with exponential backoff and
  jitter.

SQLite is configured defensively:

- `PRAGMA journal_mode = WAL` when supported, for better read/write concurrency.
- `PRAGMA busy_timeout = 5000`, so temporary writer contention can clear before
  returning `SQLITE_BUSY`.

## Idempotency behavior

For requests with `Idempotency-Key`, the service first checks for an existing
row as a fast replay path. If the stored `userId`, `type`, and `payload` match,
the existing resource is returned without consuming rate-limit quota. If the key
is reused with different request data, the service returns
`409 idempotency_conflict`.

New requests are rate limited, then inserted. `UNIQUE(idempotency_key)` is the
source of truth for preventing duplicates.

### Concurrency safety

Two concurrent requests with the same key may both miss the initial lookup.
Correctness does not depend on that lookup: SQLite enforces
`UNIQUE(idempotency_key)`, so one insert succeeds and the other receives a
unique constraint violation. The losing request fetches and returns the existing
row. At most one row can be created for a given `Idempotency-Key`.

## Retry behavior

The service retries transient database failures only:

- `SQLITE_BUSY`
- `SQLITE_LOCKED`
- simulated failures from `DB_FAIL_RATE` or `DB_FAIL_COUNT`

Retries use exponential backoff with jitter and a bounded attempt count.
Validation errors and idempotency conflicts are not retried.

Environment knobs:

- `DB_RETRY_ATTEMPTS`, default `4`
- `DB_RETRY_BASE_MS`, default `25`
- `DB_FAIL_RATE`, random simulated transient failure rate
- `DB_FAIL_COUNT`, deterministic number of initial simulated transient failures

## Rate limiting behavior

Rate limiting is per `userId` using `RATE_LIMIT_PER_MIN`, default `5`.

The local implementation uses an in-memory fixed-window counter with cleanup of
expired buckets. It is intentionally simple and correct for a single Node.js
process, but it is not multi-instance safe.

Idempotent replays that already exist do not consume rate-limit quota.

Rate-limited responses include `Retry-After` with the number of seconds until
the current window resets. Transient database `503` responses include a
conservative `Retry-After: 1` header after retry exhaustion.

## Assumptions and tradeoffs

- Idempotency keys are globally unique in this assignment schema. This service
  rejects reuse of a key with a different `userId`, `type`, or `payload`; a
  production multi-tenant system would usually scope keys by tenant and store a
  canonical request hash.
- SQLite is appropriate for local correctness tests, but 10k RPS production
  writes should move to PostgreSQL.
- The in-memory rate limiter is deliberately not presented as a production
  multi-instance solution.

## Production evolution

SQLite is used here for local correctness and simplicity. In production, the
same API contract would use PostgreSQL for durable storage, Redis for
distributed rate limiting, richer idempotency metadata such as request hashes
and cached responses, and expanded observability with metrics, tracing, and
centralized logging. See `SCALE.md` for details.

## Running

```sh
npm install
API_KEY=k npm run dev
```

Default server port is `8080`.

Example request:

```sh
curl -X POST http://127.0.0.1:8080/v1/signals \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: k' \
  -H 'Idempotency-Key: example-key' \
  -d '{"userId":"u1","type":"note","payload":"hello"}'
```

## Testing

```sh
npm install
npm test
```

Tests start isolated server processes with temporary SQLite databases. They
cover health checks, signal creation and retrieval, rate limiting, idempotent
replays, 25 parallel idempotent requests, retry handling and exhaustion,
authentication, validation, and idempotency conflict detection.

## Scale plan

See `SCALE.md` for the 10k RPS production architecture and failure-mode plan.
