# Anonymous rate limiting

Public read endpoints (`GET /api/markets`, `GET /api/leaderboard`) are throttled
per client IP using a sliding-window counter. Authenticated requests that include
a `Bearer` token bypass the limiter.

Authentication endpoints under `/api/auth` are also rate-limited with a per-identity
window (default 5 requests per minute) to reduce abuse from repeated challenge or
verification attempts. The limiter uses the submitted Stellar address when present
and falls back to the client IP otherwise.

User-facing routes under `/api/users` (excluding `/api/users/health`) use a
per-user fixed-window limiter (default **60 requests per minute**). Authenticated
callers are keyed by database user id (`users:{id}`); anonymous callers fall back
to IP. See [`docs/users-rate-limiting.md`](./users-rate-limiting.md).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANON_RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window length in milliseconds |
| `ANON_RATE_LIMIT_MAX` | `60` | Maximum anonymous requests per IP per window |
| `TRUST_PROXY` | `false` | When `true`, client IP is read from `X-Forwarded-For` |

Set `TRUST_PROXY=true` only when the app runs behind a trusted reverse proxy
that strips untrusted `X-Forwarded-For` values.

## Response when limited

HTTP **429 Too Many Requests** with:

- `Retry-After` header — seconds until the oldest request in the window expires
- Body: `{ "error": { "code": "rate_limit_exceeded", "requestId": "<id>" } }`

## Implementation

- Middleware: [`src/middleware/rateLimitAnon.ts`](../src/middleware/rateLimitAnon.ts)
- Applied on: `marketsRouter`, `leaderboardRouter`
- Status endpoint: `GET /api/rate-limit/status` (see below)
- Tests: [`tests/rateLimitAnon.test.ts`](../tests/rateLimitAnon.test.ts)

## Status endpoint

`GET /api/rate-limit/status` returns the current anonymous rate-limit state
for the caller's IP. Authenticated callers (Bearer token) receive a
`bypasses: true` response.

## Admin inspection endpoint

`GET /api/admin/rate-limit/inspect/:address` is an admin-only read-only
inspection endpoint for a target Stellar address. It returns the current
sliding-window usage, remaining quota, and reset timestamp for the address.

### Response (200)

```json
{
  "data": {
    "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "limit": 60,
    "used": 3,
    "remaining": 57,
    "windowMs": 60000,
    "resetAt": "2026-07-24T12:00:00.000Z"
  }
}
```

## Rate-limit event list

`GET /api/rate-limit` is an admin-only, cursor-paginated listing of blocked
rate-limit audit events. Results are ordered newest-first by `(created_at, id)`
so pagination stays stable when new blocked requests are written while a client
is paging through the list.

### Query parameters

- `cursor` - optional opaque token returned by the previous page
- `limit` - optional positive integer page size

### Response (200)

```json
{
  "data": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "action": "rate_limit.blocked",
      "walletAddress": null,
      "ip": "127.0.0.1",
      "correlationId": "req-123",
      "rateLimitContext": {
        "limit": 60,
        "remaining": 0,
        "resetAt": "2026-07-24T12:00:00.000Z",
        "blocked": true
      },
      "createdAt": "2026-07-24T12:00:00.000Z"
    }
  ],
  "nextCursor": "djF8MjR8..."
}
```

The endpoint uses the same standard error envelope as the rest of the API and
returns `400` for malformed query parameters, `401` for missing auth, and `403`
for non-admin callers.

### Anonymous response (200)

```json
{
  "data": {
    "type": "anonymous",
    "clientIp": "127.0.0.1",
    "limit": 60,
    "used": 3,
    "remaining": 57,
    "windowMs": 60000,
    "resetAt": "2026-07-24T12:00:00.000Z"
  }
}
```

### Authenticated response (200)

```json
{
  "data": {
    "type": "authenticated",
    "limit": 60,
    "windowMs": 60000,
    "bypasses": true
  }
}
```

## Verification

```bash
npm test -- tests/rateLimitAnon.test.ts
```
