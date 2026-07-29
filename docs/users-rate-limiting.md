# Users API rate limiting

Authenticated and anonymous requests under `GET /api/users/*` (via `usersRouter`)
use a per-identity fixed-window rate limit powered by
[`createPerUserRateLimiter`](../src/middleware/rateLimit.ts) (IETF draft-7 headers).

## Policy

| Setting | Value |
|---------|--------|
| Window | 60 seconds |
| Limit | 60 requests per key |
| Authenticated key | `users:{user.id}` (after `requireAuthForbidden` on `/me`) |
| Anonymous key | `users:ip:{socket.remoteAddress}` (public profile / predictions) |

`GET /api/users/me` runs auth **before** the limiter so the bucket is per
database user id. Public GETs are IP-keyed (Bearer on those paths does not
change the key unless `req.user` is already populated by upstream middleware).

`/api/users/health` is mounted on a separate router and is **not** rate-limited.

Social (`socialRouter`) and portfolio (`userPortfolioRouter`) mounts under
`/api/users` are unchanged by this policy.

## 429 response

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests",
    "retryAfter": 12,
    "resetAt": "2026-07-24T12:00:00.000Z"
  }
}
```

Also includes:

- `Retry-After` header (seconds)
- Draft-7 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers
- Audit event `rate_limit.blocked` with correlation ID

## Implementation

- Router: [`src/routes/users.ts`](../src/routes/users.ts)
- Middleware: [`src/middleware/rateLimit.ts`](../src/middleware/rateLimit.ts)
- Tests: [`tests/usersRateLimit.test.ts`](../tests/usersRateLimit.test.ts)

## Verification

```bash
npm test -- tests/usersRateLimit.test.ts
```
