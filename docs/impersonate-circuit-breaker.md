# Impersonate Circuit Breaker

## Overview

`POST /api/admin/users/:address/impersonate` wraps all downstream work — audit
log writes and JWT signing — in a **circuit breaker**. When the downstream is
repeatedly failing the breaker trips to the OPEN state and the endpoint
immediately returns **HTTP 503** instead of waiting for a slow or failing call
to time out.

## Why a circuit breaker?

Without one, a transient DB outage or JWT service failure causes every
impersonate call to hang until it eventually times out, holding server
resources and leaving the admin client waiting. The circuit breaker detects
the fault quickly and short-circuits all subsequent calls until the downstream
recovers, giving a fast, predictable failure signal.

## State machine

```
                    failureThreshold failures within windowMs
        ┌────────┐ ───────────────────────────────────────────► ┌──────┐
        │ CLOSED │                                              │ OPEN │
        └────────┘ ◄─────────────────────────────────────────── └──────┘
             ▲            successThreshold probe successes          │
             │                                                      │
             │                                       halfOpenAfterMs elapses
             │                                                      │
             │                  ┌───────────┐                       │
             └───────────────── │ HALF_OPEN │ ◄─────────────────────┘
                                └───────────┘
                                      │ ▲
                             probe    │ │
                             fails    └─┘ back to OPEN
```

| State | Behaviour |
|---|---|
| **CLOSED** | Normal operation. Failures are counted in a rolling `windowMs` window; any success clears the count. |
| **OPEN** | Fast-fail: every call throws `CircuitOpenError` immediately. No downstream calls are made. |
| **HALF_OPEN** | One probe at a time is allowed through; concurrent callers are fast-failed. `successThreshold` successes → CLOSED. Any failure → OPEN. |

## Default configuration

| Option | Default | Description |
|---|---|---|
| `failureThreshold` | `5` | Failures within `windowMs` that trip CLOSED → OPEN |
| `successThreshold` | `1` | Probe successes needed to reset HALF_OPEN → CLOSED |
| `halfOpenAfterMs` | `30 000` | Milliseconds in OPEN before a probe is allowed (HALF_OPEN) |
| `windowMs` | `60 000` | Rolling failure-count window |

These defaults apply when the router is instantiated without overrides.

## API behaviour

### Happy path (CLOSED state)

```
POST /api/admin/users/:address/impersonate
Authorization: Bearer <admin-jwt>

200 OK
{
  "data": {
    "token": "<impersonation-jwt>"
  }
}
```

### Circuit OPEN

```
POST /api/admin/users/:address/impersonate
Authorization: Bearer <admin-jwt>

503 Service Unavailable
Retry-After: 30
{
  "error": {
    "code": "service_unavailable",
    "message": "Impersonate service is temporarily unavailable. Please retry later.",
    "retryAfterMs": 30000,
    "requestId": "<uuid>"
  }
}
```

- `retryAfterMs` is the time **remaining** before the breaker will allow a
  probe — it counts down as the OPEN window elapses, rather than always
  reporting the full `halfOpenAfterMs`.
- `Retry-After` carries the same value in seconds (rounded up) for standard
  HTTP clients and proxies.
- When the circuit is OPEN, **no downstream calls are made** — the JWT service
  and audit service are never invoked.

### Other responses

| Status | `error.code` | Cause |
|---|---|---|
| `400` | `validation_error` | `:address` param is blank / whitespace-only |
| `403` | `forbidden` | Missing, invalid, or non-admin JWT |
| `429` | `rate_limit_exceeded` | Rate limit: 60 req/min per admin token |

Auth and validation guards run **before** circuit evaluation, so a request
without a valid admin JWT always returns 403 regardless of circuit state.

## Implementation

The circuit breaker is implemented in `src/lib/circuitBreaker.ts` as a
**generic, per-name** state machine. The registry is keyed by name so multiple
routes can each have their own isolated breaker.

```ts
import { getCircuitBreaker, CircuitOpenError } from "../../../lib/circuitBreaker";

const breaker = getCircuitBreaker("impersonate", {
  failureThreshold: 5,
  halfOpenAfterMs: 30_000,
});

const token = await breaker.execute(async () => {
  await createAuditLog(...);
  await db.insert(adminAuditLog).values(...);
  return signAccessToken({ sub: targetAddress, role: "user" });
});
```

`getCircuitBreaker` returns the shared breaker for a given name, applying any
options passed — so the endpoint's tuning is honoured regardless of which
caller resolves the breaker first. `CircuitOpenError` is caught in the route
handler and mapped to HTTP 503; all other errors are forwarded to the global
error handler.

### Route wiring

The router is mounted in `src/index.ts` on the shared `/api/admin/users`
prefix, ahead of the other routers on that prefix. Its rate limit and
`requireAdmin` guard are attached to the `POST /:address/impersonate` route
itself rather than via `router.use`, so requests for sibling paths pass
through untouched on their way to a later mount.

## Testing

### Unit tests — `tests/circuitBreaker.test.ts`

Covers every state transition, the public API (`execute`, `snapshot`, `state`),
`CircuitOpenError`, registry isolation, and both test helpers.

### Route tests — `tests/impersonateCircuitBreaker.test.ts`

Exercises the route against every circuit state:

| Scenario | Expected |
|---|---|
| CLOSED + succeeding downstream | 200 + token |
| CLOSED + failing downstream (below threshold) | 500 propagated; counter incremented |
| CLOSED + failing downstream (at threshold) | next call → 503 |
| OPEN | 503, downstream not called, `retryAfterMs` + `Retry-After` present |
| OPEN, partially elapsed | `retryAfterMs` reflects remaining time only |
| HALF_OPEN + success | 200, breaker → CLOSED |
| HALF_OPEN + failure | 500, breaker → OPEN |
| OPEN after `halfOpenAfterMs` elapses | probe allowed, responds 200 |

### Wiring tests — `tests/impersonateRouteMounted.test.ts`

Asserts the route is actually reachable through `createApp()` (a 404 there
would mean the router is not mounted) and that it does not shadow sibling
`/api/admin/users` routes.

## Runbook

### How to tell if the circuit has tripped

Look for the `circuit_breaker_opened` log line in the application logs:

```json
{
  "level": "warn",
  "circuitName": "impersonate",
  "failures": 5,
  "threshold": 5,
  "openedAt": 1722175200000,
  "state": "OPEN",
  "msg": "circuit_breaker_opened"
}
```

Each rejected request also logs `impersonate_circuit_open` at warn level with
the `correlationId`, so tripped-breaker 503s can be traced per request.

### How to tell when it recovers

```json
{
  "level": "info",
  "circuitName": "impersonate",
  "state": "CLOSED",
  "msg": "circuit_breaker_closed"
}
```

Related log events: `circuit_breaker_half_open` (probe window opened),
`circuit_breaker_probe_success` (probe succeeded but `successThreshold` not yet
met), `circuit_breaker_probe_failed_reopened` (probe failed, back to OPEN), and
`circuit_breaker_half_open_probe_busy` (a concurrent caller was fast-failed
while a probe was in flight).

### Forcing a fresh breaker (process restart)

The circuit state is **in-memory and per-process** — it resets when the process
restarts, and each instance maintains its own breaker. A rolling restart is the
quickest way to reset a stuck-open breaker if the downstream has been fixed but
the `halfOpenAfterMs` window hasn't elapsed yet.

### Adjusting thresholds

Pass custom options when constructing the router — see
`src/routes/admin/users/impersonate.ts` for the `circuitBreaker` option on
`AdminImpersonateRouterOptions`.
