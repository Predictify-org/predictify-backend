<!-- Copilot / AI agent instructions tailored for predictify-backend -->

# Copilot instructions — predictify-backend

Goal: help an AI coding agent become productive quickly in this repository by highlighting architecture, essential files, workflows, and concrete code patterns to follow.

- **Big picture**: This is a Node.js (>=20) + TypeScript Express API that indexes a Soroban/Stellar contract and exposes REST endpoints. Long-running processes (indexer, reconciliation, webhook delivery, backup verification) run as workers under `src/workers`. The main app bootstrap is `src/index.ts`.

- **Key components**:
  - HTTP API / routes: src/index.ts wires routers under `/api/*` and health endpoints.
  - Indexer & workers: `src/workers/*` (notably `indexer.ts` and `indexerGapScan.ts`). Workers connect to queues via `queue` and BullMQ.
  - Persistence: Drizzle ORM + Postgres (schema in `drizzle/` and DB client in `src/db`).
  - Queues: BullMQ backed by Redis; connection code under `src/queue` and `src/config/redis.ts`.
  - OpenAPI & docs: `openapi.yaml` and docs router (`src/routes/docs.ts`). OpenAPI JSON is generated via `scripts/generate-openapi.ts` (also invoked by `prebuild`).

- **Environment & configuration**:
  - Environment variables are the single source of runtime configuration and are strictly validated with Zod: see src/config/env-schema.ts and loader src/config/env.ts.
  - Use `scripts/check-env.ts` to validate `.env` files locally before running migrations or servers.
  - Important env keys: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (min 32 chars), `SOROBAN_RPC_URL`, `HORIZON_URL`, `PREDICTIFY_CONTRACT_ID`.

- **Concrete patterns to follow (copy-paste friendly)**:
  - Validate and parse env using the existing Zod schema. See `envSchema` in src/config/env-schema.ts.
  - When adding read endpoints that clients will poll, use `generateETag` / `conditionalGet` from src/middleware/etag.ts to support conditional GETs and 304 responses.
  - Enforce request body size limits using `createBodySizeLimitMiddleware` from src/middleware/bodySize.ts. Use `WEBHOOK_BODY_LIMIT` for webhook routes.
  - Use the existing request id flow: the app generates/propagates `REQUEST_ID_HEADER` and stores it in `requestContextStorage` (see `src/index.ts` and `src/lib/requestContext`). Use this for logging correlation.
  - Logging uses `pino` configured in src/config/logger.ts. Respect redaction and `env.LOG_LEVEL`.
  - Apply idempotency middleware for mutation requests — the app applies an `idempotency` helper for `POST`/`PATCH`; search for `idempotency` in `src/middleware`.

- **Developer workflows & commands (explicit)**:
  - Setup: `cp .env.example .env` → edit required values (`JWT_SECRET`, `DATABASE_URL`, `PREDICTIFY_CONTRACT_ID`).
  - Install & run locally:
    - `npm install`
    - `npm run check-env` (runs `scripts/check-env.ts`)
    - `npm run db:migrate` (drizzle migrations)
    - `npm run dev` (starts with `ts-node-dev`)
  - Build / start production: `npm run build` then `npm start` (entry `dist/index.js`).
  - OpenAPI generation: `npm run openapi:generate` (also runs automatically via `prebuild`). Source: `scripts/generate-openapi.ts` and `openapi.yaml`.
  - Tests:
    - Unit: `npm run test:unit` or `npm test`
    - Integration: `npm run test:integration` (uses `jest.integration.config.js`)
    - E2E: `npm run test:e2e` — E2E requires a funded Stellar testnet account, a deployed contract, and a separate test DB. See `tests/e2e/README.md` and `docs/e2e-testing.md` for setup.
  - Docker-compose: `docker compose up --build` brings up API + Postgres + indexer; ensure `.env` uses `postgres://postgres:postgres@db:5432/predictify` for compose compatibility.

- **Integration & external dependencies**:
  - Soroban / Horizon: `SOROBAN_RPC_URL` and `HORIZON_URL` → used by Stellar SDK in `src/indexer` and `services`.
  - Redis: `REDIS_URL` → used by BullMQ workers and caching (global leaderboard, rate limits).
  - Postgres: `DATABASE_URL` → Drizzle ORM migrations and repositories under `src/db`.

- **Tests and E2E caveats**:
  - E2E tests are stateful and interact with testnet; do not run them against production systems.
  - The E2E runner uses `tests/e2e/setup.ts`; local runs need network access and keys set in `.env`.

- **Where to make changes** (quick map):
  - Add API routes: `src/routes/*` and wire in `src/index.ts`.
  - Add background jobs: `src/workers/*` and ensure they are started/stopped in `src/index.ts` main block.
  - Add DB schema: `drizzle/` and use `npm run db:generate` / `npm run db:migrate`.

- **What NOT to change lightly**:
  - `src/config/env-schema.ts` is the canonical env contract — changing it affects CI, Docker, and deployment.
  - ETag semantics in `src/middleware/etag.ts` (strong SHA-256 ETags) — keep the deterministic keyed-serialization.

If anything here is unclear or missing (tests, CI behavior, or specific worker flows), tell me which area to expand and I will iterate.
