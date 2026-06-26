# predictify-backend

[![CI](https://github.com/omosvico/predictify-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/omosvico/predictify-backend/actions/workflows/ci.yml)

Backend API for **Predictify** — a Stellar/Soroban prediction-markets dApp.

This service indexes on-chain market state from the Predictify Soroban contract, exposes a REST API for the frontend, handles wallet-based authentication, and ships notifications + leaderboards.

## Stack

- **Node.js 20** + **TypeScript**
- **Express** for HTTP
- **Drizzle ORM** + **PostgreSQL** for persistence
- **zod** for env + request validation
- **pino** for structured logging
- **JWT (jsonwebtoken)** for wallet-based session auth
- **Stellar SDK** for Soroban RPC + Horizon
- **Jest** + **supertest** for tests

## Quick start

```bash
cp .env.example .env   # fill JWT_SECRET, DATABASE_URL, contract id
npm install
npm run db:migrate
npm run dev
```

## Indexer worker

A long-running worker ingests Soroban contract events and maintains a durable
cursor so ingestion resumes exactly where it left off across restarts.

```bash
npm run build && npm run indexer   # compiled (production)
npm run indexer:dev                # ts-node, auto-reload (local)
```

How it works:

- Polls `SOROBAN_RPC_URL` every `INDEXER_POLL_INTERVAL_MS` (default 5000ms) via
  `@stellar/stellar-sdk`, reading `getEvents` for `PREDICTIFY_CONTRACT_ID`
  starting just after the last ingested ledger.
- On the very first run (no cursor row yet) it starts from
  `INDEXER_START_LEDGER`.
- Each tick persists the fetched events **and** advances the
  `indexer_cursor` row in a **single database transaction**. If persistence
  fails, the transaction rolls back and the cursor is left untouched, so the
  same ledger range is safely retried on the next tick — the cursor never
  advances past events that were not stored. Event ids are unique, so a retried
  overlapping range is idempotent (`ON CONFLICT DO NOTHING`).
- Events beyond the per-tick page cap are deferred to the next tick rather than
  buffered unbounded.

### Graceful shutdown

On `SIGTERM`/`SIGINT` the worker stops scheduling new ticks, lets the in-flight
tick finish (so no partial range is dropped), closes the connection pool, and
exits `0`.

The core is exported as `pollOnce()` (`src/services/indexerService.ts`) with the
RPC source and transactional store injected, which makes it unit-testable
without a live RPC or database (`tests/indexerService.test.ts`).

## Layout

```
src/
  config/      env + logger
  routes/      health, markets (more to come)
  services/    domain services (incl. indexerService.pollOnce)
  middleware/  errorHandler, auth (planned)
  workers/     long-running processes (Soroban indexer)
  db/          drizzle schema, client, repositories
tests/         jest tests
docs/          architecture docs
scripts/       dev helpers
```

## Roadmap

This starter is intentionally minimal. The full backlog is tracked in GitHub Issues under the **OFFICIAL CAMPAIGN** label. Major themes:

- Wallet-based auth (Stellar address challenge/signature → JWT)
- Market CRUD + caching layer
- Soroban-RPC indexer with reorg/gap handling
- Predictions + claims endpoints
- Leaderboards & user profiles
- Webhook delivery + DLQ
- Observability (metrics, tracing, /readyz with deep checks)
- OpenAPI spec + contract tests

## License

MIT
