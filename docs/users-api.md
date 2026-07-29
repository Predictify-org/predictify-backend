# Users API

## `GET /api/users`

Returns a cursor-paginated list of registered users, ordered newest-first
(`createdAt DESC, id DESC`).

### Query Parameters

| Parameter | Type   | Required | Default | Constraints  | Description                                                    |
|-----------|--------|----------|---------|--------------|----------------------------------------------------------------|
| `limit`   | number | no       | `20`    | 1-100        | Number of rows to return per page.                             |
| `cursor`  | string | no       | --      | opaque token | Cursor from the previous page's `nextCursor`. Absent = page 1. |

Unknown query parameters are rejected with `400 validation_error`.

### Pagination

This endpoint uses **keyset (cursor) pagination** on `(createdAt DESC, id DESC)`.

- Pass the returned `nextCursor` verbatim as `?cursor=` to fetch the next page.
- `nextCursor` is `null` on the last page.
- Cursors are versioned. A stale or tampered cursor is safely ignored (the
  response restarts from page 1) rather than causing a 500 or a wrong offset.

### Performance

Migration `0025_users_filter_idx` adds a composite B-tree index:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_created_at_id_idx
    ON users (created_at DESC, id DESC);
```

**Without the index** the PostgreSQL planner produces:
```
Seq Scan on users  (cost=0.00..N rows=N)
  → Sort (cost=.. rows=N width=.. Sort Method: quicksort)
```
This is O(n) I/O that degrades linearly as the user count grows.

**With the index** the planner switches to:
```
Index Scan Backward using users_created_at_id_idx on users
  (cost=0.29..8.31 rows=21 width=56)
```
Key benefits:
- O(log n + page_size) I/O instead of O(n) — scales with table size.
- No sort step — the index delivers rows in the required order.
- `CONCURRENTLY` creation — no `ACCESS EXCLUSIVE` lock, zero downtime.

**Column order rationale:**
1. `created_at DESC` — the dominant sort key; satisfies the keyset `WHERE created_at < cursor_time`.
2. `id DESC` — the tie-breaker; satisfies `id < cursor_id` when two users share the same millisecond.

`stellar_address` already has an implicit B-tree index via the `UNIQUE` constraint, so
`getUserByAddress` lookups are O(log n) without any additional index.

### Rollback

To remove the index without downtime:

```sql
DROP INDEX CONCURRENTLY IF EXISTS users_created_at_id_idx;
```

`CONCURRENTLY` cannot run inside a transaction block; execute it directly.

### Response

`200 OK`

```json
{
  "data": [
    {
      "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "stellarAddress": "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
      "createdAt": "2026-06-27T12:00:00.000Z"
    }
  ],
  "nextCursor": "djF8MjR8..."
}
```

### Errors

- `400 validation_error` — invalid or unknown query parameters

### Conditional requests and caching

`GET /api/users` supports strong ETags for conditional revalidation. Every
successful response includes an `ETag` header and `Cache-Control: no-cache`.
Clients may send an `If-None-Match` header with the latest ETag to receive a
`304 Not Modified` response without a body when the page has not changed.

Example:

```http
GET /api/users
If-None-Match: "<etag>"
```

---

## `GET /api/users/me`

Returns the authenticated user's own profile. Requires a valid JWT.

Supports strong ETag / `304` conditional GET on the `{ data: profile }` payload.

### Authentication

Bearer JWT via the `Authorization: Bearer <token>` header. A missing or
invalid token returns `403 Forbidden`.

---

## `GET /api/users/:address/predictions`

Returns a cursor-paginated list of predictions for the given Stellar address.

### Path Parameters

| Parameter  | Type   | Description                          |
|------------|--------|--------------------------------------|
| `:address` | string | A valid 56-character G… Stellar address |

### Query Parameters

| Parameter | Type   | Required | Default | Constraints                                      | Description                         |
|-----------|--------|----------|---------|--------------------------------------------------|-------------------------------------|
| `status`  | string | no       | --      | `pending`/`confirmed`/`won`/`lost`/`claimed`     | Filter by prediction status.        |
| `limit`   | number | no       | `20`    | 1-100                                            | Page size.                          |
| `cursor`  | string | no       | --      | opaque token                                     | Cursor from previous `nextCursor`.  |

Supports strong ETag / `304` conditional GET on the `{ data, nextCursor }` payload.

### Errors

- `400 invalid_address` — path param is not a valid G… Stellar address
- `400 validation_error` — query params fail validation
- `404 not_found` — no user row for that address

---

## `GET /api/users/:stellarAddress/profile`

Returns the public profile for any Stellar address.

Supports strong ETag / `304` conditional GET on the `{ data: profile }` payload.

### Errors

- `400 validation_error` — invalid Stellar address
- `404 not_found` — no matching user row

---

## Rate Limiting

All `/api/users` routes apply a shared per-user rate limiter (60 req/min).
Authenticated requests key by `users:{id}`; anonymous requests key by
`users:ip:{ip}`. Rate limit headers follow IETF draft-7 (`RateLimit-*`).

## Structured Logging

Every request emits a structured log entry via `accessLog` middleware including:
- `correlationId` — resolved from `X-Correlation-Id` → `X-Request-Id` → generated UUID
- Route-specific events: `users_list_request`, `users_list_served`, etc.

Pass `X-Correlation-Id: <uuid>` to correlate log entries with a specific request.
