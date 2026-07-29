# Markets API rate limiting

Authenticated requests to `GET /api/markets` use a per-user fixed-window rate limit.

- Default limit: **60 requests per minute per authenticated wallet**
- The authenticated wallet address is used as the rate-limit key.
- Requests without an authenticated wallet identity are keyed by the client socket IP.
- A rejected request returns HTTP `429` with the standard error envelope:

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

The response also includes a `Retry-After` header containing the number of seconds before retrying. Rate-limit decisions are logged with the request correlation ID and audited using the `rate_limit.blocked` action.
