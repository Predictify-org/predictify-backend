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
cp .env.example .env        # copy the template
# Edit .env — set JWT_SECRET, DATABASE_URL, and PREDICTIFY_CONTRACT_ID
# (all other keys have working testnet defaults)

npm install
npm run check-env           # validate .env before touching the DB
npm run db:migrate
npm run dev                  # predev hook re-runs check-env automatically
```

`check-env` also runs automatically before `npm start` (production).  
If a required variable is missing you get a readable bullet list instead of a stack trace:

```
✖  Environment validation failed:

  • JWT_SECRET: String must contain at least 32 character(s)
  • DATABASE_URL: Invalid url

Copy .env.example → .env and set the values marked as required.
```

### Environment variables

Every variable is documented in `.env.example` and validated by the zod schema in
`src/config/env-schema.ts`.  Required variables (no default):

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random secret ≥ 32 chars (`openssl rand -hex 32`) |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `HORIZON_URL` | Horizon REST API endpoint |
| `PREDICTIFY_CONTRACT_ID` | Deployed contract address (56-char Strkey) |

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
