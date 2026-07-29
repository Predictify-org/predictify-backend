# Impersonate Circuit Breaker

## Overview

`POST /api/admin/users/:address/impersonate` wraps all downstream work — JWT
signing and audit log writes — in a **circuit breaker**. When the downstream
is repeatedly failing the breaker trips to the OPEN state and the endpoint
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
           ┌─────────────────────────────────────────┐
           │                                         │
           ▼   failureThreshold consecutive fails    │
        CLOSED ───────────────────────────────► OPEN
           ▲                                    │
           │                           halfOpenAfterMs elapses
           │                                    │
           │                                    ▼
           │   successThreshold successes   HALF_OPEN
           └────────────────────────────────────┘
                                           │
                              probe fails  │
                                    ┌──────┘
                                    ▼
                                  OPEN
```

| State | Behaviour |
|---|---|
| **CLOSED** | Normal operation. Failures are counted. |
| **OPEN** | Fast-fail: every call throws `CircuitOpenError` immediately. No downstream calls are made. |
| **HALF_OPEN** | One probe call is allowed through. Success → CLOSED. Failure → OPEN. |

## Default configuration

| Option | Default | Description |
|---|---|---|
| `failureThreshold` | `5` | Consecutive failures that trip CLOSED → OPEN |
| `successThreshold` | `1` | Consecutive probe successes needed to reset OPEN → CLOSED |
| `halfOpenAfterMs` | `30 000` | Milliseconds in OPEN before a probe is allowed (HALF_OPEN) |

These defaults are applied when the router is instantiated without overrides.

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
{
  "error": {
    "code": "service_unavailable",
    "message": "Impersonate service is temporarily unavailable. Please retry later.",
    "retryAfterMs": 30000,
    "requestId": "<uuid>"
  }
}
```

- `retryAfterMs` tells the caller how long before the breaker will allow a
  probe (i.e. the configured `halfOpenAfterMs` value).
- When the circuit is OPEN, **no downstream calls are made** — the JWT service
  and audit service are never invoked.

### Other responses

| Status | `error.code` | Cause |
|---|---|---|
| `400` | `validation_error` | `:address` param is blank / whitespace-only |
| `403` | `forbidden` | Missing, invalid, or non-admin JWT |
| `429` | `rate_limit_exceeded` | Rate limit: 60 req/min per admin token |

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

The `CircuitOpenError` is caught in the route handler and mapped to HTTP 503.
All other errors are forwarded to the global error handler.

## Testing

### Unit tests — `tests/circuitBreaker.test.ts`

Tests every state transition, the public API (`execute`, `snapshot`, `state`),
`CircuitOpenError`, and both test helpers.

### Integration tests — `tests/impersonateCircuitBreaker.test.ts`

Tests the route end-to-end against every circuit state:

| Scenario | Expected |
|---|---|
| CLOSED + succeeding downstream | 200 + token |
| CLOSED + failing downstream (below threshold) | 500 propagated; counter incremented |
| CLOSED + failing downstream (at threshold) | next call → 503 |
| OPEN | 503, downstream not called, `retryAfterMs` present |
| HALF_OPEN + success | 200, breaker → CLOSED |
| HALF_OPEN + failure | 500, breaker → OPEN |
| OPEN after `halfOpenAfterMs` elapses | probe allowed, responds 200 |

Auth and validation guards run **before** circuit evaluation, so a request
without a valid admin JWT always returns 403 regardless of circuit state.

## Runbook

### How to tell if the circuit has tripped

Look for the `circuit_breaker_opened` log line in the application logs:

```json
{
  "level": "warn",
  "circuitName": "impersonate",
  "failures": 5,
  "openedAt": 1722175200000,
  "msg": "circuit_breaker_opened"
}
```

### How to tell when it recovers

```json
{
  "level": "info",
  "circuitName": "impersonate",
  "state": "CLOSED",
  "msg": "circuit_breaker_closed"
}
```

### Forcing a fresh breaker (process restart)

The circuit state is **in-memory only** and resets when the process restarts.
A rolling restart is the quickest way to reset a stuck-open breaker if the
downstream has been fixed but the `halfOpenAfterMs` window hasn't elapsed yet.

### Adjusting thresholds

Pass custom options when constructing the router — see
`src/routes/admin/users/impersonate.ts` for the `circuitBreaker` option on
`AdminImpersonateRouterOptions`.
