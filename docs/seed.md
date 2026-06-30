# Sample Market Seeding (non-production)

`POST /api/admin/seed` inserts a small, fixed batch of **sample markets** so that
E2E suites and demos have predictable data to work against. It is intended for
**development, staging, and test** environments only.

- **Source:** [`src/routes/admin/seed.ts`](../src/routes/admin/seed.ts),
  [`src/services/seedService.ts`](../src/services/seedService.ts)
- **Related:** [errors.md](./errors.md), [log-events.md](./log-events.md),
  [rate-limiting.md](./rate-limiting.md)

## Endpoint

```
POST /api/admin/seed
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{}            # empty body — the endpoint takes no parameters
```

### Success — `200 OK`

```json
{
  "data": {
    "requested": 5,
    "inserted": 5,
    "skipped": 0,
    "batchVersion": 1,
    "insertedIds": [
      "seed-market-001",
      "seed-market-002",
      "seed-market-003",
      "seed-market-004",
      "seed-market-005"
    ],
    "markets": [
      {
        "id": "seed-market-001",
        "question": "Will BTC close above $100k by year end?",
        "status": "open",
        "resolutionTime": "2026-07-30T10:00:00.000Z"
      }
    ]
  }
}
```

| Field         | Meaning                                                              |
| ------------- | ------------------------------------------------------------------- |
| `requested`   | Number of sample markets the batch defines (currently 5).           |
| `inserted`    | Rows **this call** actually created.                                 |
| `skipped`     | Rows that already existed and were left untouched (idempotent skip). |
| `batchVersion`| Version of the sample batch that produced the seed.                 |
| `insertedIds` | Ids created by this call (empty on a repeat run).                    |
| `markets`     | Every seeded market currently tracked in the database.              |

## Behaviour

### Non-production only

The endpoint is unavailable in production:

- In production the router responds **`404 not_found`** *before* authentication,
  so the route is not even probeable.
- As defense-in-depth, `seedSampleMarkets()` itself throws `SeedNotAllowedError`
  (→ `403 seed_not_allowed`) if invoked when `NODE_ENV=production`, so sample
  data can never be written to a production database even via a direct call.

### Idempotent

Each sample market has a **stable primary key** (`seed-market-001` …). Inserts
use `ON CONFLICT (id) DO NOTHING`, so:

- The **first** call inserts the full batch (`inserted: 5, skipped: 0`).
- Every **subsequent** call inserts nothing (`inserted: 0, skipped: 5`) and
  returns `200`. No duplicates are ever created.

### Tracked

Every seeded row is tagged in its `metadata` column:

```json
{ "seeded": true, "seedBatchVersion": 1, "outcomes": ["yes", "no"] }
```

Seeded markets can therefore be listed and distinguished from real
(indexed / admin-created) markets — `seedService.listSeeded()` returns exactly
the rows where `metadata->>'seeded' = 'true'`.

## Security

| Layer            | Behaviour                                                     |
| ---------------- | ------------------------------------------------------------ |
| Production guard  | `404` in production (route hidden, runs before auth).        |
| Rate limit        | `30 req/min` per admin token (IP fallback) → `429`.          |
| Admin auth        | Valid admin JWT required; otherwise `403 forbidden`.         |
| Input validation  | Body validated with a strict schema; extra fields → `400 validation_error`. |

## Observability

- Emits a `market.created` structured log event per inserted row, carrying the
  `correlationId`, the admin `actor`, and `seeded: true`.
- Writes an `admin.seed_markets` entry to `audit_logs` (actor address, IP,
  correlation id).
- Responses and logs propagate the request id via the standard
  `X-Request-Id` correlation header.

## Error envelope

All errors use the standard envelope:

```json
{ "error": { "code": "validation_error", "details": [], "requestId": "<id>" } }
```

| Status | `code`                | When                                            |
| ------ | --------------------- | ----------------------------------------------- |
| 400    | `validation_error`    | Unexpected fields in the request body.          |
| 403    | `forbidden`           | Missing / invalid / non-admin JWT.              |
| 403    | `seed_not_allowed`    | Service invoked directly in production.          |
| 404    | `not_found`           | Endpoint called in production.                   |
| 429    | `rate_limit_exceeded` | Per-token rate limit exceeded.                  |

## Example

```bash
curl -X POST http://localhost:3001/api/admin/seed \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{}'
```
