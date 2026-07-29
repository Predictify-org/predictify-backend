# Reports API rate limiting

All endpoints under `/api/reports` (including `/api/reports/scheduled`) are
throttled using a **per-user token-bucket** rate limiter applied at the parent
router level (`src/routes/reports.ts`).

## Algorithm

The token-bucket algorithm allows short bursts while enforcing an average rate.

| Parameter | Default | Description |
|-----------|---------|-------------|
| Capacity | 60 | Maximum tokens (burst size) |
| Refill window | 60 000 ms | Time to fully replenish the bucket |
| Refill rate | 1 token / ms | Linear refill (60 tokens per 60 s) |

Each request consumes **1 token**. When the bucket is empty the request is
rejected with HTTP **429**.

## Key generation

The bucket key is derived from the authenticated user's identity in this order:

1. `user.id` (database primary key)
2. `user.address` (Stellar public key)
3. `user.sub` (JWT subject claim)
4. Client socket IP (fallback for anonymous requests — should not occur since
   all `/api/reports` routes require authentication)

Each unique key gets its own independent bucket.

## Response headers

Every response (both allowed and blocked) includes draft-7 `RateLimit-*` headers:

| Header | Description |
|--------|-------------|
| `RateLimit-Limit` | Bucket capacity (e.g. `60`) |
| `RateLimit-Remaining` | Tokens left after this request |
| `RateLimit-Reset` | Unix timestamp (seconds) when the next token becomes available |

When blocked, an additional header is set:

| Header | Description |
|--------|-------------|
| `Retry-After` | Seconds until the client should retry |

## 429 error envelope

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests",
    "retryAfter": 1,
    "resetAt": "2026-07-24T12:00:01.000Z"
  }
}
```

## Audit trail

Every rate-limit block creates an audit log entry via `createAuditLog` with:

- `action`: `"rate_limit.blocked"`
- `ip`: Client IP address
- `correlationId`: Request correlation ID
- `rateLimitContext`: `{ limit, remaining, resetAt, blocked: true }`

## Configuration

The limiter is configured in `src/routes/reports.ts` via `ReportsRouterOptions`:

```typescript
const router = createReportsRouter({
  rateLimit: {
    capacity: 60,        // tokens
    refillWindowMs: 60000, // milliseconds
  },
});
```

## Implementation

- Parent router: [`src/routes/reports.ts`](../src/routes/reports.ts)
- Middleware: [`src/middleware/rateLimit.ts`](../src/middleware/rateLimit.ts) — `createPerUserTokenBucketLimiter`
- Tests: [`tests/tokenBucketRateLimit.test.ts`](../tests/tokenBucketRateLimit.test.ts), [`tests/reportsRouter.test.ts`](../tests/reportsRouter.test.ts)

## Example

```bash
# Successful request (returns rate-limit headers)
curl -i -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/reports/scheduled

# HTTP/1.1 200 OK
# RateLimit-Limit: 60
# RateLimit-Remaining: 59
# RateLimit-Reset: 1753372801

# After exhausting the bucket
curl -i -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/reports/scheduled

# HTTP/1.1 429 Too Many Requests
# Retry-After: 1
# RateLimit-Limit: 60
# RateLimit-Remaining: 0
# RateLimit-Reset: 1753372801
#
# { "error": { "code": "rate_limit_exceeded", "message": "Too many requests", "retryAfter": 1, "resetAt": "2026-07-24T12:00:01.000Z" } }
```
