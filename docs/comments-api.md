# Comments API

The comments API exposes read/write access to market comments and propagates
`X-Correlation-Id` through every handler and any outbound HTTP call made within
the same request lifecycle.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/comments` | None | Root list endpoint |
| `POST` | `/api/comments` | None | Create a comment |
| `GET` | `/api/markets/:id/comments` | None | List comments for a market (cursor-paginated) |

---

### `GET /api/comments`

Returns a paginated list of comments.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer 1–100 | No | Page size (default: 20) |
| `cursor` | string | No | Opaque cursor returned by the previous page |

**Request headers**

| Header | Description |
|--------|-------------|
| `X-Correlation-Id` | Optional. Alphanumeric + hyphens + underscores, max 128 chars. A UUID v4 is generated when absent. Unsafe characters are silently stripped. |

**Response headers**

| Header | Description |
|--------|-------------|
| `X-Correlation-Id` | The resolved correlation ID (passed-through or freshly generated). |

**200 response**

```json
{
  "data": [],
  "nextCursor": null,
  "message": "Comments fetched securely"
}
```

---

### `POST /api/comments`

Creates a new comment. If `outboundUrl` is supplied the service dispatches a
`POST` to that URL containing the comment payload; `X-Correlation-Id` is
forwarded automatically via `fetchWithCorrelationId`.

Outbound call failures are logged as warnings — they do **not** affect the
`201` response returned to the caller.

**Request headers**

| Header | Description |
|--------|-------------|
| `X-Correlation-Id` | Optional. Propagated to the outbound webhook call when `outboundUrl` is set. |

**Request body**

```json
{
  "marketId": "market-abc",
  "body": "Great prediction!",
  "authorAddress": "GABC...",
  "outboundUrl": "https://notifications.example.com/webhook"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `marketId` | string | **Yes** | Target market ID |
| `body` | string 1–2000 chars | **Yes** | Comment text |
| `authorAddress` | string | No | Stellar address of the author |
| `outboundUrl` | URL string | No | Outbound webhook URL |

**Response headers**

| Header | Description |
|--------|-------------|
| `X-Correlation-Id` | Resolved correlation ID, echoed back. |

**201 response**

```json
{
  "data": {
    "id": "c-1753712345678",
    "marketId": "market-abc",
    "body": "Great prediction!",
    "authorAddress": "GABC...",
    "createdAt": "2026-07-28T16:00:00.000Z"
  },
  "message": "Comment created successfully"
}
```

---

### `GET /api/markets/:id/comments`

Returns cursor-paginated comments for a single market, ordered newest-first.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Market ID |

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer 1–100 | No | Page size (default: 20) |
| `cursor` | string | No | Opaque cursor from the previous page |

**Request headers**

| Header | Description |
|--------|-------------|
| `X-Correlation-Id` | Optional. See rules above. |

**Response headers**

| Header | Description |
|--------|-------------|
| `X-Correlation-Id` | Resolved correlation ID. |

**200 response**

```json
{
  "data": [
    {
      "id": "c-abc",
      "marketId": "m-123",
      "authorId": null,
      "authorAddress": null,
      "body": "I think YES wins.",
      "moderationFlagged": false,
      "moderationReason": null,
      "createdAt": "2026-07-28T16:00:00.000Z"
    }
  ],
  "nextCursor": "eyJzb3J0VmFsdWUiOi..."
}
```

---

## X-Correlation-Id behaviour

All three endpoints share the same correlation ID resolution logic (implemented
in [`src/middleware/correlation.ts`](../src/middleware/correlation.ts)):

1. **Accept** — the value from the incoming `X-Correlation-Id` request header
   (priority 1), then `X-Request-Id` (priority 2), then the pino-http `req.id`
   (priority 3).
2. **Sanitise** — strip characters outside `[A-Za-z0-9\-_]` and truncate to
   128 characters to prevent log-injection attacks.
3. **Generate** — if the sanitised value is empty, generate a fresh RFC 4122
   UUID v4.
4. **Store** — write the resolved ID into the
   [AsyncLocalStorage](../src/lib/requestContext.ts) context so downstream
   service code can call `getCorrelationId()` without prop-drilling.
5. **Echo** — set `X-Correlation-Id` on the HTTP response so callers can
   correlate their own traces.
6. **Propagate** — outbound HTTP calls made via
   `fetchWithCorrelationId(url, init)` (exported from
   `src/middleware/correlation.ts`) automatically inject the correlation ID
   from the current ALS context into the outgoing request's
   `X-Correlation-Id` header.

### Structured log fields

Every handler logs `correlationId` and `reqId` together so a single grep or
log query can reconstruct the full request chain:

```json
{
  "level": 30,
  "correlationId": "client-corr-id-12345",
  "reqId": "client-corr-id-12345",
  "marketId": "m-123",
  "msg": "market comments listed"
}
```

---

## Error envelope

Validation failures return a standard error envelope:

```json
{
  "error": {
    "code": "validation_error",
    "details": [...]
  }
}
```

HTTP status codes: `400` (validation), `404` (not found), `500` (unexpected).

---

## Rate limiting & CORS

All comments routes inherit the global anonymous rate limit
(`rateLimitAnon`) and the markets CORS allowlist (`marketsCors()`).
