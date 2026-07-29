# Admin Health Detail

## Overview

`GET /api/admin/health/detail` — detailed runtime health snapshot for operators.

Returns three parallel sub-checks in a single response:

| Check | What it measures |
|---|---|
| `dbPool` | PostgreSQL connection pool stats (total / idle / waiting) + `SELECT 1` liveness |
| `indexer` | Last indexed ledger from `indexer_cursor`, Soroban RPC chain tip, and lag |
| `rpc` | Soroban RPC reachability and latest ledger sequence |

---

## Security

- Requires a valid admin JWT — `Authorization: Bearer <token>` with `role: "admin"`.
- Rate-limited to **30 requests per minute** per admin token.
- Returns `403 Forbidden` for any of: missing header, wrong role, expired/invalid token.
- No audit log write — this is a read-only diagnostic endpoint.

---

## HTTP status codes

| Code | Meaning |
|---|---|
| `200 OK` | All three checks are `ok` |
| `207 Multi-Status` | One or more checks are `degraded` or `error` |
| `403 Forbidden` | Missing or non-admin JWT |
| `429 Too Many Requests` | Rate limit exceeded |

---

## Response shape

```jsonc
{
  "dbPool": {
    "status": "ok",          // "ok" | "degraded" | "error"
    "latencyMs": 3,
    "stats": {
      "total": 10,           // Total connections in the pool
      "idle": 7,             // Idle (available) connections
      "waiting": 0           // Clients queued waiting for a connection
    }
    // "error": "..." — present only when status is "error"
  },
  "indexer": {
    "status": "ok",
    "latencyMs": 12,
    "lastIndexedLedger": 1000,   // null if cursor table is empty
    "chainTip": 1010,            // null if RPC is unreachable
    "lagLedgers": 10             // null when either value is unavailable
    // "error": "..."
  },
  "rpc": {
    "status": "ok",
    "latencyMs": 8,
    "latestLedger": 1010         // null if RPC is unreachable
    // "error": "..."
  },
  "checkedAt": "2026-06-29T10:00:00.000Z"
}
```

### `CheckStatus` values

| Value | Meaning |
|---|---|
| `ok` | Sub-check passed |
| `degraded` | Operational but outside acceptable bounds (e.g. indexer lag > `INDEXER_LAG_ALERT_THRESHOLD`) |
| `error` | Sub-check threw an exception or timed out |

---

## Indexer lag threshold

The indexer check uses the same threshold as the background health probe:

```dotenv
INDEXER_LAG_ALERT_THRESHOLD=200   # ledgers (default)
```

When `lagLedgers > INDEXER_LAG_ALERT_THRESHOLD`, `indexer.status` becomes `"degraded"` and the response returns HTTP `207`.

When `lastIndexedLedger` is `null` (cursor table empty) or `chainTip` is `null` (RPC down), `lagLedgers` is `null` and status is `"degraded"`.

---

## Timeouts

Each sub-check has an independent 5 s timeout. A timed-out check returns `status: "error"` with `error: "Probe timed out"`. One slow dependency cannot stall the others.

---

## Implementation

| File | Role |
|---|---|
| `src/services/adminHealthService.ts` | Pure service — data collection, fully injectable |
| `src/routes/admin/health.ts` | Express router — auth, rate-limit, HTTP mapping |
| `src/openapi/registry.ts` | OpenAPI spec registration |
| `tests/adminHealthDetail.test.ts` | Service unit tests + HTTP integration tests |
