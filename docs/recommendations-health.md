# `GET /api/recommendations/health`

Health probe for the `/api/recommendations` subsystem. Reports the status
of the two external dependencies the recommendations pipeline relies on.

---

## Why it exists

The recommendations endpoint surfaces personalised markets by querying
Postgres (for prediction history and market data) against a corpus of
markets that were indexed from the Soroban chain. If either dependency is
unavailable, personalised recommendations cannot be served. This probe lets
orchestrators and dashboards surface the root cause quickly.

---

## Request

```
GET /api/recommendations/health
```

No authentication required. No request body or query parameters.

Pass `X-Correlation-Id` to correlate the probe response with your
distributed-trace or alerting system:

```
X-Correlation-Id: my-trace-id-42
```

---

## Response

### 200 OK — all dependencies healthy

```json
{
  "status": "ok",
  "correlationId": "3a6d1f2c-...",
  "checkedAt": "2026-07-28T19:27:42.000Z",
  "dependencies": {
    "database":   { "status": "ok", "latencyMs": 4  },
    "sorobanRpc": { "status": "ok", "latencyMs": 18 }
  }
}
```

### 503 Service Unavailable — at least one dependency is down

```json
{
  "status": "down",
  "correlationId": "3a6d1f2c-...",
  "checkedAt": "2026-07-28T19:27:42.000Z",
  "dependencies": {
    "database":   { "status": "ok",   "latencyMs": 3    },
    "sorobanRpc": { "status": "down", "latencyMs": 5000, "error": "Soroban RPC unavailable" }
  }
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` \| `"down"` | Composite: `"ok"` only when **both** probes pass |
| `correlationId` | string | Echoes `X-Correlation-Id` header, or a generated UUID |
| `checkedAt` | ISO-8601 string | Timestamp of the probe run |
| `dependencies.database.status` | `"ok"` \| `"down"` | Postgres reachability |
| `dependencies.database.latencyMs` | number | Round-trip time in ms |
| `dependencies.database.error` | string? | Present only when `status = "down"` |
| `dependencies.sorobanRpc.status` | `"ok"` \| `"down"` | Soroban RPC reachability |
| `dependencies.sorobanRpc.latencyMs` | number | Round-trip time in ms |
| `dependencies.sorobanRpc.error` | string? | Present only when `status = "down"` |

---

## Probes

| Dependency | Probe method | Healthy signal |
|---|---|---|
| `database` | `SELECT 1` against the Postgres connection pool | Query resolves without error |
| `sorobanRpc` | `getLatestLedger()` against `SOROBAN_RPC_URL` | Response received without error |

Both probes run in parallel (`Promise.all`). The endpoint is **not** cached —
every request runs fresh probes. If you need caching, add a reverse-proxy or
sidecar cache in front of this path.

---

## HTTP status codes

| Code | Meaning |
|---|---|
| `200` | All dependency probes passed. |
| `503` | At least one dependency probe failed. The response body names which one. |
| `500` | An unexpected error was thrown inside a probe (not a graceful failure). Check logs with the `correlationId`. |

---

## Structured log events

Every probe run emits a `pino` log entry at level `info`:

```json
{
  "level": 30,
  "correlationId": "…",
  "status": "ok",
  "httpStatus": 200,
  "elapsedMs": 22,
  "database": "ok",
  "sorobanRpc": "ok",
  "msg": "recommendations_health_check_complete"
}
```

Unexpected errors emit at level `error`:

```json
{
  "level": 50,
  "correlationId": "…",
  "err": { … },
  "elapsedMs": 5,
  "msg": "recommendations_health_probe_threw"
}
```

---

## Security

- No authentication required — the response contains no secrets or user data.
- In production, restrict access at the infrastructure level (internal ALB
  rule, VPC-only routing, service-mesh policy, etc.) so external clients
  cannot reach this path.

---

## Related endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check — no I/O |
| `GET /healthz/dependencies` | Shallow cached probe (all 4 deps, 5 s TTL) |
| `GET /api/health/ready` | Deep readiness for orchestrators |
| `GET /api/predictions/health` | Predictions-subsystem probe (same shape) |
| `GET /api/indexer/health` | Indexer health with cursor lag |
