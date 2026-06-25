# predictify-backend

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

## Database migrations

This project uses **Drizzle Kit** to generate and run PostgreSQL migrations.

| Command | Purpose |
|---|---|
| `npm run db:generate` | Generate a new migration from schema changes |
| `npm run db:migrate`  | Apply pending migrations to the database |
| `npm run db:check-drift` | CI check — fails if schema changed but no migration covers it |

### Workflow

1. Edit `src/db/schema.ts` to add or modify tables.
2. Run `npm run db:generate` — creates a new file under `drizzle/`.
3. Review the generated SQL and commit it alongside the schema change.
4. CI runs `npm run db:check-drift` to ensure schema and migrations stay in sync.

> Never edit a committed migration. Always generate a new one.

## Layout

```
src/
  config/      env + logger
  routes/      health, markets (more to come)
  services/    domain services
  middleware/  errorHandler, auth (planned)
  db/          drizzle schema
tests/         jest tests
drizzle/       generated migrations + meta
scripts/       dev helpers (check-drizzle-drift.ts)
.github/
  workflows/   CI pipeline (lint, test, drift check, migrate)
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
