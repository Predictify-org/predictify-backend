# `/api/health/ready` — Deep Readiness Check Runbook

## Overview

`GET /api/health/ready` is an uncached deep readiness probe intended for use by
Kubernetes/ECS readiness probes, load-balancer health checks, and monitoring systems.

Unlike `/healthz/dependencies` (cached 5 s, returns 207 for degraded), this endpoint:

- Runs **every call**, uncached
- Returns only `200` (ready) or `503` (unready) — no 207
- Declares ready only when **all four** probes pass

## Response shape

```json
{
  "status": "ready",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "checkedAt": "2026-07-24T12:00:00.000Z",
  "checks": {
    "db":         { "status": "pass", "durationMs": 4,  "message": "Database connection healthy" },
    "sorobanRpc": { "status": "pass", "durationMs": 18, "message": "Soroban RPC healthy" },
    "indexerLag": { "status": "pass", "durationMs": 22, "message": "Indexer lag healthy: 12 ≤ 200 ledgers" },
    "queue":      { "status": "pass", "durationMs": 2,  "message": "Queue (Redis) healthy" }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | `"ready"` \| `"unready"` | Aggregate |
| `correlationId` | UUID | Echoed from `x-correlation-id` header, or auto-generated |
| `checkedAt` | ISO 8601 | Timestamp when the check completed |
| `checks.*.status` | `"pass"` \| `"fail"` | Per-probe |
| `checks.*.durationMs` | number | Probe elapsed time (ms) |
| `checks.*.message` | string | Human-readable result or error |

## HTTP status codes

| Code | Meaning |
|---|---|
| `200 OK` | All probes passed — ready to accept traffic |
| `503 Service Unavailable` | One or more probes failed |

## Probes

### `db` — Postgres
Runs `SELECT 1` with a 1 s timeout. Fails if the pool is exhausted, the query throws, or it times out.

### `sorobanRpc` — Soroban RPC
Calls `getLatestLedger()` on `SOROBAN_RPC_URL` with a 1 s timeout.

### `indexerLag` — Indexer cursor lag
Reads `indexer_cursor.last_ledger` and compares to `getLatestLedger().sequence`. Fails when:
- The row doesn't exist (indexer never started)
- `chainTip − lastIndexed > READINESS_MAX_LAG_LEDGERS` (default 200)

Mainnet produces ~1 ledger/5 s, so 200 ledgers ≈ ~17 minutes of tolerated lag.

### `queue` — Redis / BullMQ
Issues a Redis `PING` with a 1 s timeout. Fails if the response is not `PONG`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | BullMQ Redis connection |
| `SOROBAN_RPC_URL` | — | Soroban RPC endpoint (required) |
| `READINESS_MAX_LAG_LEDGERS` | `200` | Max tolerated indexer lag ledgers |

## Correlation IDs

Pass `x-correlation-id` in the request header; it is echoed in the response body
and every structured log line, making it easy to correlate probe failures in the
pino log stream:

```bash
kubectl logs -l app=predictify-backend | jq 'select(.correlationId == "my-run-id")'
```

## Kubernetes example

```yaml
readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
  timeoutSeconds: 3
```

## Structured logs

Each call emits one INFO entry on completion:

```json
{
  "level": 30,
  "msg": "health_ready_check_complete",
  "correlationId": "…",
  "status": "ready",
  "elapsedMs": 28,
  "checks": { "db": { … }, "sorobanRpc": { … }, "indexerLag": { … }, "queue": { … } }
}
```

Individual probe failures are additionally logged at ERROR (`msg: "readiness_*_check_failed"`).

## Security

No authentication required. The endpoint exposes only health metadata — no
application data. Restrict access at the infrastructure level (VPC / ingress allowlist)
so orchestrators can reach it but it is not publicly exposed.
