# Scale Plan

## Why This Implementation

SQLite is sufficient for this assignment because it provides durable local
storage and real uniqueness constraints without external services. The database
unique key is the source of truth for idempotency; the initial lookup is only a
fast replay path. The same API semantics can evolve to PostgreSQL for storage
and Redis for distributed rate limiting.

## Assumptions & Constraints

- The current implementation prioritizes correctness and simplicity.
- SQLite is not intended for sustained 10k RPS production writes.
- Rate limiting is process-local in this assignment.
- Idempotency keys are globally unique in the assignment schema.
- Expensive downstream processing should move to asynchronous workers.

## Data Model & Indexes

The important constraints are:

- `UNIQUE(idempotency_key)` to prevent duplicate idempotent writes.
- `(user_id, created_at)` to support listing a user's recent signals.

At production scale, this moves to PostgreSQL with the same logical indexes,
likely scoped by tenant or account if the product becomes multi-tenant.

## Idempotency at Scale

Database uniqueness remains the correctness boundary. App instances can race on
insert; one succeeds, and the others handle the conflict by fetching the
existing row. If a write succeeds but the HTTP response is lost, the client
retry uses the same `Idempotency-Key`, hits the existing row or the unique
constraint, and no duplicate is created.

Production idempotency metadata would also store a canonical request hash and,
if useful, the response body/status for faster replays and safer conflict
detection.

## Rate Limiting at Scale

The in-memory limiter is correct only for one process. Multi-instance production
rate limiting should use Redis with atomic `INCR`/TTL or Lua scripts so all API
instances share the same counter state.

## Horizontal Scaling

- Run stateless Fastify instances behind a load balancer.
- Keep correctness-critical state out of process memory.
- Autoscale on CPU, latency, error rate, and queue depth.

## Database & Caching

- Use PostgreSQL as the primary durable store.
- Use connection pooling such as PgBouncer or driver-level pooling.
- Add read replicas if list/read traffic becomes significant.
- Use Redis caching for read-heavy derived data or replay responses, but keep
  relational uniqueness as the idempotency source of truth.

## Queues

If signal ingestion triggers expensive work, keep the request path small:
transactionally write the signal and an outbox record, then have workers publish
or process jobs through Kafka, SQS, or Pub/Sub. Downstream consumers should be
idempotent using signal IDs.

## Retry & Failure Handling

Retry only transient failures with exponential backoff, jitter, and bounded
attempts. Do not retry validation errors or idempotency conflicts. Add circuit
breakers around dependencies so outages fail fast instead of amplifying load.

## Observability

- Metrics: request latency, error rate, idempotency replay count, retry
  exhaustion count.
- Logs: request ID, idempotency key hash, route, status, and error code.
- Tracing: OpenTelemetry spans across HTTP handling, rate limiting,
  idempotency/DB work, and queue publication.
