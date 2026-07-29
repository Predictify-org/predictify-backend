# Predictions Listing API

## `GET /api/predictions`

Returns a cursor-paginated list of predictions belonging to the **authenticated user**.

---

### Authentication

Requires a valid JWT in the `Authorization: Bearer <token>` header.
Returns `401 unauthenticated` when the token is absent, expired, or invalid.

The authenticated predictions listing endpoint is also protected by a per-user rate limit of `60` requests per minute. Once that quota is exceeded, the endpoint returns `429 rate_limit_exceeded` with `Retry-After` and `resetAt` metadata.

---

### Query Parameters

| Parameter  | Type   | Required | Default | Constraints       | Description                                                   |
|------------|--------|----------|---------|-------------------|---------------------------------------------------------------|
| `limit`    | number | no       | `20`    | 1–100             | Number of rows to return per page.                            |
| `cursor`   | string | no       | —       | opaque token      | Cursor from the previous page's `nextCursor`. Absent = page 1.|
| `marketId` | string | no       | —       | 1–128 chars       | Filter to a specific market.                                  |
| `status`   | string | no       | —       | enum (see below)  | Filter by prediction lifecycle status.                        |
| `outcome`  | string | no       | —       | 1–64 chars        | Filter by chosen outcome (e.g. `"yes"` / `"no"`).            |

**Status enum values:** `pending` · `confirmed` · `won` · `lost` · `claimed`

---

### Pagination

This endpoint uses **keyset (cursor) pagination** on `(createdAt DESC, id DESC)`.

- Pass the returned `nextCursor` verbatim as `?cursor=` to fetch the next page.
- `nextCursor` is `null` on the last page.
- Cursors are versioned. A stale or tampered cursor is safely ignored (the
  response restarts from page 1) rather than causing a 500 or a wrong offset.

```
GET /api/predictions?limit=20

{
  "data": [ ... ],
  "nextCursor": "djF8MjR8..."
}

GET /api/predictions?limit=20&cursor=djF8MjR8...

{
  "data": [ ... ],
  "nextCursor": null     ← last page
}
```

---

### Response Shape

**200 OK**

```json
{
  "data": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "marketId": "market-abc",
      "question": "Will ETH reach $10k by end of 2026?",
      "outcome": "yes",
      "amount": "100",
      "txHash": "abc123...",
      "status": "pending",
      "result": null,
      "createdAt": "2026-06-27T12:00:00.000Z",
      "resolutionTime": "2027-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "djF8MjR8..."
}
```

**400 validation_error** — invalid query parameters

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid enum value. Expected 'pending' | 'confirmed' | ...",
    "requestId": "req-uuid"
  }
}
```

**401 unauthenticated** — missing or invalid JWT

```json
{
  "error": { "code": "unauthenticated" }
}
```

**429 rate_limit_exceeded** — per-user quota exceeded

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests",
    "retryAfter": 60,
    "resetAt": "2026-07-25T12:34:56.000Z"
  }
}
```

---

### Implementation Details

#### Repository (`src/repositories/predictionRepo.ts`)

- Executes a single `SELECT … INNER JOIN markets … WHERE … ORDER BY createdAt DESC, id DESC LIMIT limit+1` query.
- The `limit + 1` probe determines whether a next page exists without a separate `COUNT(*)` round-trip.
- All filter conditions (`userId`, `marketId`, `status`, `outcome`) are injected as parameterised Drizzle column expressions — no string interpolation, so SQL injection is structurally impossible.
- The cursor keyset predicate is:
  ```sql
  (createdAt < cursorTime)
  OR (createdAt = cursorTime AND id < cursorId)
  ```
  This is the standard two-column keyset predicate for `DESC (createdAt, id)` ordering.

#### Route (`src/routes/predictions.ts`)

- Input validated with Zod at the route boundary before any DB access.
- `requireAuth` middleware enforces authentication; `req.user.id` is always populated when the handler executes.
- A per-user `createPerUserRateLimiter` protects the authenticated predictions routes at `60` requests/minute per user, returning a standard `429` error envelope with retry metadata.
- Structured logging via `pino` with `reqId` (from `x-request-id`) and `userId` on every log entry.
- Errors bubble to the global `errorHandler` middleware for standardised envelopes.

#### Cursor Encoding (`src/utils/cursor.ts`)

Cursors are versioned base64url tokens encoding `{ sortValue: ISO-string, id: UUID }`.
Version mismatches (e.g. after a schema migration) cause the cursor to be silently
discarded rather than mis-paginating.

---

### Differences from `GET /api/users/:address/predictions`

| Feature               | `/api/predictions`              | `/api/users/:address/predictions` |
|-----------------------|---------------------------------|-----------------------------------|
| Auth                  | Required (caller's own data)    | None (public, by Stellar address) |
| Scope                 | Authenticated user only         | Any Stellar address               |
| Filters               | marketId, status, outcome       | status only                       |
| Data source           | `predictionRepo.listPredictions`| `userService.getUserPredictions`  |
