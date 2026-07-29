# predictify-backend

[![CI](https://github.com/omosvico/predictify-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/omosvico/predictify-backend/actions/workflows/ci.yml)

Backend API for **Predictify** — a Stellar/Soroban prediction-markets dApp.

This service indexes on-chain market state from the Predictify Soroban contract, exposes a REST API for the frontend, handles wallet-based authentication, and ships notifications + leaderboards.

## Stack

- **Node.js 20** + **TypeScript**
- **Express** for HTTP
- **Drizzle ORM** + **PostgreSQL** for persistence
- **BullMQ** + **Redis** for async job queues (webhook delivery, backup verification, reconciliation, market resolution)
- **zod** for env + request validation
- **pino** for structured logging
- **JWT (jsonwebtoken)** for wallet-based session auth
- **Stellar SDK** for Soroban RPC + Horizon
- **Jest** + **supertest** for tests

## Quick start

```bash
cp .env.example .env        # copy the template
# Edit .env — set JWT_SECRET, DATABASE_URL, and PREDICTIFY_CONTRACT_ID
# (all other keys have working testnet defaults)

npm install
npm run check-env           # validate .env before touching the DB
npm run db:migrate
npm run dev                  # predev hook re-runs check-env automatically
```

Once running:

- **Swagger UI** → http://localhost:3001/docs *(non-production only; set `ENABLE_DOCS=true` to enable in production)*
- **OpenAPI JSON** → http://localhost:3001/openapi.json *(always available)*
- **Audit export** → `GET /api/admin/audit/export` streams admin audit logs as `application/x-ndjson`
- **Audit counts** → `GET /api/audit/counts` returns a per-action counts summary of audit log entries for admin dashboards


## Health Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | None | Liveness check — returns `{ "status": "ok" }` immediately. Use this to verify the process is up. |
| `GET /healthz/dependencies` | None | Shallow dependency probe — Postgres, Soroban RPC, Horizon, webhook queue (Redis). Cached for 5 s. Returns 200/207/503. |
| `GET /api/health/ready` | None | **Deep readiness check** — runs four parallel probes with 1-second timeouts each. Returns 200 when ready, 503 when unready. |
| `GET /api/indexer/health` | None | Indexer health — probes external dependencies (Postgres + Soroban RPC) and compares the persisted cursor against the chain tip. Returns `"ok"` / `"degraded"` / `"down"` with dependency statuses in `dependencies` and lag data in `data`. Always HTTP 200. Supports [ETag / conditional GET](#etag--conditional-get-caching). |
| `GET /api/recommendations/health` | None | Recommendations subsystem health — probes the two runtime dependencies the recommendations pipeline relies on (Postgres + Soroban RPC). Returns 200 when all pass, 503 when any is down. Response shape mirrors `GET /api/predictions/health`. |

### `GET /api/health/ready` response

```json
{
  "status": "ready",
  "correlationId": "<uuid>",
  "checkedAt": "2026-07-24T12:00:00.000Z",
  "checks": {
    "db":         { "status": "pass", "durationMs": 4,  "message": "Database connection healthy" },
    "sorobanRpc": { "status": "pass", "durationMs": 18, "message": "Soroban RPC healthy" },
    "indexerLag": { "status": "pass", "durationMs": 22, "message": "Indexer lag healthy: 12 ≤ 200 ledgers" },
    "queue":      { "status": "pass", "durationMs": 2,  "message": "Queue (Redis) healthy" }
  }
}
```

- `status` is `"ready"` only when **all four** probes pass; otherwise `"unready"`.
- HTTP 200 → ready, HTTP 503 → unready.
- Pass `x-correlation-id` header to correlate log entries with the request.
- `READINESS_MAX_LAG_LEDGERS` (env, default `200`) controls the indexer lag threshold.
- Not cached — orchestrators (Kubernetes, ECS) get a fresh signal on every poll.

See [docs/health-ready.md](docs/health-ready.md) for full runbook.

## ETag / conditional GET caching

Select read endpoints emit a strong `ETag` (SHA-256 of the response body) and honor
`If-None-Match` with a `304 Not Modified` when the caller's cached copy is still
current — this cuts bandwidth for clients that poll frequently. Implemented in
[src/middleware/etag.ts](src/middleware/etag.ts) (`conditionalGet`).

Currently applied to:

- `GET /api/markets` / `GET /api/markets/:id`
- `GET /api/users` / `GET /api/users/me` / `GET /api/users/:address/predictions` /
  `GET /api/users/:stellarAddress/profile`
- `GET /api/auth/*` (session-derived responses)
- `GET /api/indexer/health` — cursor/chain-tip lag rarely changes between polls, so
  monitoring/orchestrator probes that hit this endpoint on a tight interval get a
  bodyless `304` instead of re-downloading the same status on every tick.

Behavior:

- Every `200` response includes `ETag` and `Cache-Control: no-cache` (clients may
  cache, but must revalidate before reuse).
- Send the previously-received `ETag` value back as `If-None-Match` to revalidate;
  a match returns `304` with no body, a mismatch returns a fresh `200`.
- Error responses (e.g. `404`) never carry an `ETag`.

## Request body size limits

- Default JSON request body limit: `256kb`.
- Route-level overrides are applied in middleware using `createBodySizeLimitMiddleware(...)` from `src/middleware/bodySize.ts`.
- Webhook routes may opt into a larger limit of `1mb`.
- Requests exceeding the configured limit return HTTP `413` with the standard error envelope, including correlation and request IDs.

## Per-user concurrency limit

All `/api` routes are protected by a per-user in-flight request cap provided by `src/middleware/perUserConcurrency.ts`.

**What it limits:** the number of *concurrent* (simultaneously in-flight) requests from a single identity — not throughput over a time window.  This prevents a single misbehaving client from holding many long-lived connections open and exhausting the server's thread pool or database connection pool.

**Identity resolution:**
1. `req.user.id` — set by `requireAuth` / `optionalAuth`
2. `req.user.stellarAddress` — fallback from the same middlewares
3. First hop of `X-Forwarded-For` / `req.socket.remoteAddress` — anonymous callers

**When the limit is exceeded:**

```
HTTP 429 Too Many Requests
Retry-After: 1
```

```json
{
  "error": {
    "code": "concurrency_limit_exceeded",
    "message": "Too many concurrent requests",
    "retryAfter": 1
  }
}
```

**Configuration** (`MAX_CONCURRENT_REQUESTS_PER_USER`, default `10`):

```bash
# .env
MAX_CONCURRENT_REQUESTS_PER_USER=10
```

**Advanced use** — create a custom instance with a different limit for a specific route group:

```ts
import { createPerUserConcurrencyMiddleware } from "./middleware/perUserConcurrency";
router.use(createPerUserConcurrencyMiddleware({ limit: 3 }));
```

> **Multi-process note:** The counter is in-process only.  In a clustered deployment each process enforces the limit independently, so the effective cap across N processes is `N × MAX_CONCURRENT_REQUESTS_PER_USER`.  For single-process deployments (the standard Docker Compose setup) the limit is exact.

## Indexer gap scan

The gap-scan worker detects missing ledger ranges in `indexer_events` between the durable cursor and chain tip, emits `indexer_gap_detected_total{from,to}`, and self-heals via `backfillRange`:

```bash
npm run indexer:gap-scan
```

Configure via `INDEXER_GAP_SCAN_INTERVAL_MS`, `INDEXER_REWIND_LEDGERS`, and `INDEXER_BACKFILL_CHUNK_SIZE` in `.env`.

## Job Queue (BullMQ + Redis)

Slow and IO-bound jobs (webhook delivery, backup verification, market resolution, reconciliation) run in
BullMQ workers backed by Redis. See **[docs/job-queue.md](docs/job-queue.md)** for the full design,
enqueue patterns, environment variables, and testing guide.

Quick start:

```bash
docker run -p 6379:6379 redis:7-alpine   # local Redis
# Set REDIS_URL=redis://localhost:6379 in .env
npm run dev
```

## Layout

```
src/
  config/      env + logger
  routes/      health, markets (more to come)
  services/    domain services
  workers/     indexer gap scan worker
  metrics/     in-process counters (indexer_gap_detected_total)
  middleware/  errorHandler, auth (planned)
  workers/     long-running processes (Soroban indexer)
  db/          drizzle schema, client, repositories
tests/         jest tests
drizzle/       generated migrations + meta
scripts/       dev helpers (check-drizzle-drift.ts)
.github/
  workflows/   CI pipeline (lint, test, drift check, migrate)
```

## Feature Flags

The public feature-flags endpoint returns the current flag state for client consumption:

- **`GET /api/feature-flags`** — returns `{ data: { FLAG: { enabled, metadata? }, ... }, correlationId }`. Optional query params: `environment` and `clientVersion`.

A **5-second per-request timeout** is enforced. Requests that exceed it receive `HTTP 504` with `{ error: { code: "gateway_timeout", ... } }`. The handler uses cooperative cancellation via `AbortSignal` so in-flight work is abandoned cleanly. See [docs/feature-flags.md](docs/feature-flags.md) for the full runbook.

## Global Leaderboard

A platform-wide leaderboard aggregated across **all markets and all time** is available at:

- **`GET /api/leaderboard/global`** — paginated global rankings (`limit`, `offset`, `refresh` params)
- **`GET /api/leaderboard/global/user/:stellarAddress`** — single-user global entry

Results are cached in Redis for 5 minutes. Passing `refresh=true` forces an immediate `REFRESH MATERIALIZED VIEW CONCURRENTLY`. See [docs/global-leaderboard.md](docs/global-leaderboard.md) for full documentation.

## Roadmap

This starter is intentionally minimal. The full backlog is tracked in GitHub Issues under the **OFFICIAL CAMPAIGN** label. Major themes:

- Wallet-based auth (Stellar address challenge/signature → JWT)
- Market CRUD + caching layer
- Soroban-RPC indexer with reorg/gap handling
- Predictions + claims endpoints
- Leaderboards & user profiles
- Webhook delivery + DLQ
- Observability (metrics, tracing, /readyz with deep checks ✅ `/api/health/ready`)
- OpenAPI spec + contract tests

## Auth Refresh Flow

- `POST /api/auth/refresh` accepts `{ "refreshToken": "<opaque token>" }`, revokes the presented refresh token, and returns a fresh `accessToken` plus a rotated `refreshToken`.
- Refresh tokens are stored only as SHA-256 hashes in the `refresh_tokens` table. The raw bearer token is generated once and is never persisted.
- If a revoked refresh token is presented again, the service treats it as suspected theft and revokes every still-active token in the same `familyId`.
- `POST /api/auth/logout` accepts the same body and revokes the remaining active tokens in that refresh-token family.

## Testing

### Unit Tests

Run the unit test suite:

```bash
npm test              # Run all tests
npm run test:unit     # Run unit tests only (excludes E2E)
npm run test:coverage # Run with coverage report
```

### E2E Tests

End-to-end tests validate the complete prediction lifecycle on Stellar testnet:

```bash
npm run test:e2e           # Run E2E tests
npm run test:e2e:coverage  # Run E2E tests with coverage
```

**E2E tests validate:**
- User authentication with wallet signatures
- Market creation on testnet
- Placing predictions
- Market resolution
- Claiming winnings
- Data consistency across the lifecycle

**Setup required:**
- Funded Stellar testnet account
- Deployed Predictify contract on testnet
- Test database (separate from dev/prod)

See [tests/e2e/README.md](tests/e2e/README.md) and [docs/e2e-testing.md](docs/e2e-testing.md) for detailed setup and usage.

**CI/CD:**
- E2E tests run nightly at 2 AM UTC
- Manual trigger via GitHub Actions
- Automatic issue creation on failure

### Refresh Token Tests

```bash
npm test -- tests/refreshToken.test.ts
```

The refresh-token test suite covers rotation, expiry handling, reuse detection, logout family revocation, and hash-only storage.

## Comments API

Market comments are exposed at:

- **`GET /api/markets/:id/comments`** — cursor-paginated comments for a market (`limit`, `cursor` params)
- **`GET /api/comments`** — root list endpoint
- **`POST /api/comments`** — create a comment; supply `outboundUrl` to dispatch a webhook

Every handler generates or preserves an `X-Correlation-Id`, sanitises it (strips characters outside `[A-Za-z0-9\-_]`, max 128 chars), stores it in AsyncLocalStorage, echoes it in the response header, and propagates it to any outbound HTTP call via `fetchWithCorrelationId`. See [docs/comments-api.md](docs/comments-api.md) for the full runbook.

## Social graph

Follow graph mutations are exposed at:

- `POST /api/users/:addr/follow`
- `DELETE /api/users/:addr/follow`

These endpoints require authentication, enforce `users.is_private`, update
cached `followers_count` and `following_count` values transactionally, and
write structured audit entries with the request correlation ID.

## Run with Docker

You can spin up the entire Predictify stack (API, Indexer, and PostgreSQL) using Docker Compose.

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) installed and running.
- A local `.env` file generated from `.env.example`. Ensure `DATABASE_URL` is set to `postgres://postgres:postgres@db:5432/predictify` for Docker compatibility.

### Commands

1. **Start the stack:**
   ```bash
   docker compose up --build
   ```
   
2. Verify the services:
   Once booted, the API will be available at http://localhost:3001.
   Check the health endpoint:
   ```bash
   curl localhost:3001/health
   # Expected response: 200 OK
   ```
### Notes
* The migrate service runs automatically on startup to ensure the database schema is up-to-date before the API and Indexer start.

* The indexer service runs as a persistent container; check the logs with docker compose logs -f indexer if you encounter sync issues.

### Implementation Notes for Review
*   **Performance:** Multi-stage builds reduce the final image size by excluding source code and dev dependencies.
*   **Security:** By using `USER node` and `slim` base images, we reduce the attack surface.
*   **Resilience:** The `depends_on` condition using `service_healthy` or `service_completed_successfully` ensures the database is ready and migrations are applied before application services boot, preventing race conditions.
*   **Supply-Chain:** The base image is pinned by a specific digest. **Important:** When you run this, verify the digest matches your local build requirements, or update it to the latest `node:20-bookworm-slim` digest if you prefer the absolute latest patch version.

## Structured Access Logging

The API emits structured JSON access logs for several route groups via the `accessLog` middleware (`src/middleware/accessLog.ts`).

### Logged routes

| Route prefix      | Log name                |
|-------------------|-------------------------|
| `/api/users`      | `users_access_log`      |
| `/api/auth`       | `auth_access_log`       |
| `/api/predictions`| `predictions_access_log`|
| `/api/markets`    | `markets_access_log`    |
| `/api/tags`       | `tags_access_log`       |
| `/api/feature-flags` | `feature_flags_access_log` |
| `/api/referrals`  | `referrals_access_log`  |
| `/api/admin`      | `admin_access_log`      |

### Log fields

Every access-log entry contains:

| Field          | Type   | Description |
|----------------|--------|-------------|
| `req-id`       | string | Correlation / request ID (same as `correlationId`) |
| `correlationId`| string | Resolved via `X-Correlation-Id` → `X-Request-Id` → `req.id` → new UUID |
| `method`       | string | HTTP verb (GET, POST, etc.) |
| `path`         | string | Request path (no query string) |
| `statusCode`   | number | Final HTTP response status |
| `status`       | number | Alias for `statusCode` |
| `durationMs`   | number | Wall-clock response time in ms |
| `latency`      | number | Alias for `durationMs` |
| `ip`           | string | Client IP (X-Forwarded-For or direct) |
| `size`         | number | Response body size in bytes (`Content-Length` or 0) |
| `actor`        | string | Authenticated actor ID or `"anonymous"` |

### Actor resolution

- **Admin routes** (`/api/admin/*`): uses `req.adminAddress` (set by `requireAdmin` middleware after JWT verification with `role: "admin"`)
- **User routes**: uses `req.user.id`
- **Unauthenticated requests**: logged as `"anonymous"`

### Correlation IDs

The `X-Correlation-Id` response header is echoed back for every logged request. The resolution priority chain is:

1. `X-Correlation-Id` request header (sanitised: alphanumeric + `-_` only, max 128 chars)
2. `X-Request-Id` request header
3. `req.id` (set by `pino-http`)
4. Fresh UUID v4 (guaranteed fallback)

### Security

- Only `req.path` is logged (no query strings or full URLs)
- `req.headers.authorization` and `req.headers.cookie` are redacted by the logger
- Actor information is limited to a stable identifier (Stellar address or user ID)
- Correlation IDs from clients are sanitised to prevent log injection

## License

MIT
