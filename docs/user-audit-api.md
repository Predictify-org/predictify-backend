# Per-User Audit History — `GET /api/audit/user/:addr`

## Overview

Returns a paginated list of audit log entries for a single Stellar wallet address. This endpoint supports the GrantFox FWC26 campaign requirement for per-user audit history.

## Authentication & Authorisation

| Caller | Allowed addresses |
|--------|------------------|
| Authenticated user (any role) | Own `stellarAddress` only |
| Admin (`role: "admin"`) | Any address |

All requests require a valid `Authorization: Bearer <JWT>` header. Missing or invalid tokens receive **401**. A valid user querying a different user's address receives **403**.

## Request

```
GET /api/audit/user/:addr
```

### Path parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `addr` | string | ✓ | Stellar public key — must match `G[A-Z2-7]{55}` |

Returns **400** if the address does not match the Stellar public-key format.

### Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cursor` | string | — | Opaque pagination cursor from the previous page's `nextCursor`. Omit for the first page. |
| `limit` | integer | `20` | Records per page. Clamped to 1–100. |
| `action` | string | — | Exact-match filter on the `action` field (e.g. `"auth.login"`). |
| `startDate` | ISO 8601 | — | Inclusive lower-bound on `created_at`. |
| `endDate` | ISO 8601 | — | Inclusive upper-bound on `created_at`. |

Unknown query parameters are rejected with **422**.

## Response

### 200 OK

```json
{
  "data": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "action": "auth.login",
      "walletAddress": "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
      "ip": "203.0.113.42",
      "correlationId": "abc-def-123",
      "rateLimitContext": null,
      "createdAt": "2026-07-01T12:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Entries are ordered by `(created_at DESC, id DESC)`. The `nextCursor` field is `null` when there are no further pages.

### Error responses

| Status | `error.code` | Cause |
|--------|-------------|-------|
| 400 | `request_failed` | `:addr` is not a valid Stellar public key |
| 401 | `unauthenticated` | Missing or invalid Bearer token |
| 403 | `forbidden` | Caller is requesting another user's history without admin role |
| 422 | `validation_error` | Invalid query parameter (bad `limit`, `startDate`, etc.) |
| 429 | `rate_limit_exceeded` | More than 60 requests/minute from the same token |
| 500 | `internal_error` | Unexpected server error |

All error responses follow the standard envelope:

```json
{
  "error": {
    "code": "forbidden",
    "message": "You are not authorised to view audit logs for this address",
    "correlationId": "abc-def-123"
  }
}
```

## Pagination

Pagination uses the same opaque keyset cursor as `GET /api/admin/audit`. The cursor encodes `(created_at, id)` of the last row on the current page. Never construct a cursor manually — always use the `nextCursor` value returned by the API.

```
GET /api/audit/user/GABC...?limit=2
→ { data: [{...}, {...}], nextCursor: "eyJ..." }

GET /api/audit/user/GABC...?limit=2&cursor=eyJ...
→ { data: [{...}], nextCursor: null }
```

See [audit-log-pagination.md](./audit-log-pagination.md) for the full pagination contract.

## Rate limiting

60 requests per minute per JWT token (falls back to IP when the `Authorization` header is absent). Exceeding the limit returns **429** with `{ "error": { "code": "rate_limit_exceeded" } }`.

## Structured logging

Every successful request emits a `user_audit_fetch` log line at `info` level:

```json
{
  "correlationId": "...",
  "addr": "GABC...",
  "filters": { "action": null, "startDate": null, "endDate": null, "limit": 20, "hasCursor": false },
  "callerAddress": "GABC...",
  "msg": "user_audit_fetch"
}
```

Forbidden attempts (non-admin querying another address) emit a `user_audit_forbidden` warning:

```json
{
  "correlationId": "...",
  "callerAddress": "GABC...",
  "requestedAddress": "GXYZ...",
  "msg": "user_audit_forbidden"
}
```

## Relevant files

| File | Purpose |
|------|---------|
| `src/routes/audit/user.ts` | Route handler |
| `src/repositories/auditLogRepo.ts` | `getAuditLogsByUser()` — DB query |
| `src/middleware/requireAuth.ts` | JWT authentication |
| `src/utils/cursor.ts` | Cursor encode/decode |
| `src/__tests__/routes/auditUser.test.ts` | Unit tests |
| `openapi.yaml` | OpenAPI spec (`/api/audit/user/{addr}`) |
