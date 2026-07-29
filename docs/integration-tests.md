# Integration tests

Integration tests run against an ephemeral Postgres instance provisioned by [Testcontainers](https://node.testcontainers.org/) for every test run. This gives a real database without manual setup.

## Prerequisites

- Docker (any recent version)
- Node.js 20+

## Running

```bash
npm run test:integration
```

This uses the `jest.preset.integration.js` preset which:

1. Starts a `postgres:16-alpine` container (global setup)
2. Sets `DATABASE_URL` to point at the container
3. Runs test files matching `tests/integration/**/*.test.ts`
4. Stops and removes the container (global teardown)

## Writing integration tests

Place test files in `tests/integration/` with the `*.test.ts` extension.

Import `pool`, `db`, or `closeDb` from `../../src/db/client` to interact with the database:

```ts
import { pool, db, closeDb } from "../../src/db/client";

describe("my feature", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("reads and writes data", async () => {
    const result = await pool.query("SELECT 1 AS value");
    expect(result.rows[0].value).toBe(1);
  });
});
```

## How it works

- **`jest.preset.integration.js`** — Jest configuration that activates the integration preset.
- **`globalSetup.js`** — Spins up a `PostgreSqlContainer` before the suite, writes the connection URI and container ID to `tests/integration/.container-info.json`.
- **`setup.ts`** — Read by Jest as a `setupFile`; loads the connection URI from `.container-info.json` and sets `process.env.DATABASE_URL` before any module is imported.
- **`globalTeardown.js`** — Stops the Postgres container and removes the info file.

## Environment variables

| Variable | Set by | Notes |
|---|---|---|
| `DATABASE_URL` | `setup.ts` | Dynamically generated from container |
| `NODE_ENV` | `setup.ts` | Hard-coded to `test` |
| `JWT_SECRET` | `setup.ts` | Static test value |
| `SOROBAN_RPC_URL` | `setup.ts` | Points to testnet |
| `HORIZON_URL` | `setup.ts` | Points to testnet |
| `PREDICTIFY_CONTRACT_ID` | `setup.ts` | Static test value |
| `PG_POOL_MAX` | `setup.ts` | Defaults to `10` |
| `PG_STATEMENT_TIMEOUT_MS` | `setup.ts` | Defaults to `5000` |
| `LOG_LEVEL` | `setup.ts` | Set to `silent` to reduce noise |

## Cleanup

The container is stopped and removed in `globalTeardown.js`. If the teardown does not run (e.g. `SIGKILL`), `docker stop` / `docker rm` the container manually:

```bash
docker ps --filter label=com.predictify.integration=postgres
docker stop <container-id>
docker rm <container-id>
```

The `.container-info.json` file is listed in `.gitignore` and never committed.

## Coverage

Integration tests are excluded from the default `npm test` unit suite. Run them separately with `npm run test:integration`.

When adding new code, integration tests should cover database interactions that are not suitable for unit tests (e.g. Drizzle ORM transactions, raw SQL queries, connection pool behaviour).
