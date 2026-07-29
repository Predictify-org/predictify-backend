# Feature Flags

The Feature Flag service provides a fast, cached flag evaluation mechanism backed by Postgres.

## Public Endpoint

### `GET /api/feature-flags`

Returns the current feature-flag state for client consumption.

**Authentication:** None required (public endpoint).

**Query parameters (all optional):**

| Parameter       | Type                                          | Description                               |
|-----------------|-----------------------------------------------|-------------------------------------------|
| `environment`   | `"development"` \| `"testnet"` \| `"mainnet"` | Context hint forwarded to the evaluator.  |
| `clientVersion` | `string`                                      | Semver / build string for the caller.     |

Unknown query parameters are silently stripped.

**Response — 200 OK:**
```json
{
  "data": {
    "ENABLE_DOCS": { "enabled": true },
    "BETA_PREDICTION_MARKETS": { "enabled": false, "metadata": { "targetUser": null } }
  },
  "correlationId": "abc123"
}
```

**Error responses:**

| Status | `error.code`       | Cause                                         |
|--------|--------------------|-----------------------------------------------|
| `400`  | `validation_error` | `environment` is not a recognised enum value. |
| `504`  | `gateway_timeout`  | The service did not respond within 5 s.       |

**504 envelope:**
```json
{
  "error": {
    "code": "gateway_timeout",
    "message": "Feature-flags request timed out",
    "requestId": "<correlationId>"
  }
}
```

### Per-request timeout

The route applies a **5-second hard deadline** using `requestTimeout` from
`src/middleware/timeout.ts`. This prevents a slow or locked Postgres query from
holding the connection open indefinitely.

When the deadline fires:

1. The `AbortController` exposed on `res.locals.abortSignal` is signalled.
2. The handler's in-flight `abortableRace` call rejects with `RequestAbortedError`.
3. The handler catches `RequestAbortedError` and returns without touching the
   response (the 504 was already sent by the middleware).
4. A structured log is emitted at `WARN` level:

```jsonc
{
  "level": "warn",
  "msg": "request_timeout_exceeded",
  "correlationId": "<id>",
  "timeoutMs": 5000,
  "path": "/api/feature-flags",
  "method": "GET"
}
```

Followed immediately by a breadcrumb from the handler:

```jsonc
{
  "level": "warn",
  "msg": "Abandoned /api/feature-flags request after timeout",
  "correlationId": "<id>",
  "path": "/"
}
```

To adjust the deadline, change `FEATURE_FLAGS_TIMEOUT_MS` in
`src/routes/feature-flags.ts`.

### Correlation ID

Every response includes a `correlationId` field (in the body) and an
`x-correlation-id` response header. Clients may supply their own value via
`x-correlation-id` on the request — it will be echoed back sanitised (max 128
characters, alphanumeric + hyphens/underscores only).

---

## Cache Invalidation Strategy

To ensure flag evaluations are highly performant (e.g. they don't add latency
to typical requests), the flags are stored in an in-memory `Map` within the
Node process.

The strategy is:

1. On application startup, all feature flags are loaded from the database into
   memory.
2. A background `setInterval` polling loop runs every `FLAGS_CACHE_TTL_SECONDS`
   (default: 30 seconds) to fetch the latest state from the database.
3. If the background fetch fails, the error is logged and the stale cache is
   retained to prevent the application from crashing or losing flag evaluations.
4. Any mutation via the Admin API (`POST`, `PATCH`, `DELETE`) immediately writes
   through to Postgres and updates the local cache instance. This ensures
   read-after-write consistency for the writer. Other horizontally scaled nodes
   will pick up the change within the polling window.

## Configuration

## API Endpoints (Public)

- `GET /api/feature-flags` — List active feature flags.
  - Query: `cursor` (optional), `limit` (optional, default 20, max 100)
  - Response: `{ items: Array<{ id, enabled, variant }>, next_cursor: string | null, total: number }`
  - `next_cursor` is `null` on the last page. Pass it verbatim as `?cursor=` to fetch the next page.

## API Endpoints (Admin Only)

## Admin API Endpoints

- `GET /api/admin/feature-flags` - List all flags.
- `GET /api/admin/feature-flags/:key` - Get a single flag. Returns 404 if not found.
- `POST /api/admin/feature-flags` - Create a new flag.
  - Body: `{ key: string, enabled: boolean, variant?: string, description?: string }`
- `PATCH /api/admin/feature-flags/:key` - Partially update a flag.
  - Body: `{ enabled?: boolean, variant?: string, description?: string }`
- `DELETE /api/admin/feature-flags/:key` - Delete a flag.
