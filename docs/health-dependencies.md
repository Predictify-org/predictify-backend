# `GET /api/health/dependencies`

Probes all four external dependencies in parallel and returns a per-system health snapshot.

---

## Endpoint summary

| Property        | Value                                                  |
|-----------------|--------------------------------------------------------|
| **Method**      | `GET`                                                  |
| **Path**        | `/api/health/dependencies`                             |
| **Auth**        | None                                                   |
| **Caching**     | None (fresh probe on every request)                    |
| **Timeout**     | 5 s per probe (inherited from `probeAllDependencies`)  |

---

## Probed systems

| Key            | What is checked                                             |
|----------------|-------------------------------------------------------------|
| `postgres`     | `SELECT 1` against the Postgres connection pool             |
| `sorobanRpc`   | `getLatestLedger()` call to the configured Soroban RPC node |
| `horizon`      | HTTP `GET` to the configured Horizon root URL               |
| `webhookQueue` | Redis `PING` via the BullMQ connection                      |

---

## Response codes

| HTTP Status | Meaning                                          |
|-------------|--------------------------------------------------|
| `200 OK`    | All four probes return `ok`                     |
| `207 Multi-Status` | At least one probe is `degraded`, none are `down` |
| `503 Service Unavailable` | At least one probe is `down`         |

---

## Response body

```json
{
  "status": "ok",
  "correlationId": "e2a1c4d7-1234-5678-abcd-ef0123456789",
  "checkedAt": "2026-07-24T22:00:00.000Z",
  "dependencies": {
    "postgres":     { "status": "ok",   "latencyMs": 3  },
    "sorobanRpc":   { "status": "ok",   "latencyMs": 12 },
    "horizon":      { "status": "ok",   "latencyMs": 8  },
    "webhookQueue": { "status": "ok",   "latencyMs": 1  }
  }
}
```

### Fields

| Field                            | Type                          | Description                                                  |
|----------------------------------|-------------------------------|--------------------------------------------------------------|
| `status`                         | `"ok"` \| `"degraded"` \| `"down"` | Composite status — worst single probe wins.             |
| `correlationId`                  | `string` (UUID)               | Echoed from `x-correlation-id` header, or generated.        |
| `checkedAt`                      | ISO-8601 string               | UTC timestamp of the response.                               |
| `dependencies.<system>.status`   | `"ok"` \| `"degraded"` \| `"down"` | Per-system probe result.                                |
| `dependencies.<system>.latencyMs`| `number`                      | Round-trip time for the probe, in milliseconds.              |
| `dependencies.<system>.error`    | `string` (optional)           | Human-readable error detail — only present when `down`.     |

---

## Composite status logic

```
all probes "ok"                          → status "ok"
any probe "down"                         → status "down"
some "degraded", none "down"             → status "degraded"
```

---

## Correlation ID

Pass `x-correlation-id: <id>` in the request header to correlate the response
and server logs with your upstream trace. A UUID is generated automatically when
the header is absent or empty.

---

## Example requests

```bash
# All healthy
curl -s http://localhost:3001/api/health/dependencies | jq .status
# "ok"

# With correlation ID
curl -s http://localhost:3001/api/health/dependencies \
  -H "x-correlation-id: my-trace-abc" | jq .correlationId
# "my-trace-abc"
```

---

## Related health endpoints

| Endpoint                   | Auth | Caching | Purpose                                         |
|----------------------------|------|---------|-------------------------------------------------|
| `GET /health`              | None | No      | Liveness check — process is up                 |
| `GET /healthz/dependencies`| None | 5 s TTL | Shallow cached probe (same four systems)        |
| `GET /api/health/ready`    | None | No      | Deep readiness — adds indexer-lag check         |
| `GET /api/health/dependencies` | None | No | Full detail, injectable, uncached (this page)  |

---

## Security notes

- The endpoint exposes no sensitive data (no credentials, tokens, or user data).
- Restrict access to internal network paths at the infrastructure level (internal ALB, VPC-only routing, security groups) in production.
- The response body deliberately omits internal connection strings or configuration values.
