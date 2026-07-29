# Webhook delivery & dead-letter queue (DLQ)

Implements issue #76: when the dispatcher exhausts retries, a delivery lands in a
dead-letter table that an operator can inspect and replay.

> **Scope note.** Issue #76 targets the DLQ layer, but the webhook subsystem it
> builds on (delivery table, dispatcher, admin auth, cursor pagination) did not
> yet exist in the starter repo. This change therefore adds the minimal
> supporting pieces needed to make the DLQ real and reviewable, alongside the DLQ
> itself. Each piece is small and independently useful. See "What this PR adds".

## What this PR adds

| Area | File | Purpose |
| --- | --- | --- |
| Schema | `src/db/schema.ts` | `webhook_deliveries` (live queue) + `webhook_deliveries_dlq` (mirror + `lastError`), plus a `bytea` column type |
| Migration | `drizzle/0001_webhook_dlq.sql` | Creates both tables and their indexes |
| DB client | `src/db/client.ts` | Lazy pg `Pool` + drizzle client (none existed before) |
| Store | `src/services/webhookStore.ts` | `WebhookStore` interface + types + `InMemoryWebhookStore` |
| Store (prod) | `src/services/drizzleWebhookStore.ts` | Postgres-backed `WebhookStore` |
| Dispatcher | `src/services/webhookDispatcher.ts` | Retry with backoff, DLQ-on-exhaustion, replay |
| Auth | `src/middleware/requireAdmin.ts` | JWT admin guard (401 / 403) |
| Pagination | `src/utils/cursor.ts` | Shared keyset cursor helper |
| Routes | `src/routes/adminWebhooks.ts` | `GET /dlq`, `POST /dlq/:id/replay` |
| **DLQ list (dedicated)** | **`src/routes/admin/webhooks/dlq.ts`** | **`GET /api/admin/webhooks/dlq` — focused route with Zod validation, structured logging, rate limiting** |
| Wiring | `src/index.ts` | Mounts admin router; injectable deps for tests |

## Data model

`webhook_deliveries` is the live queue. A delivery is created per outbound event,
attempted by the dispatcher, and retried with exponential backoff up to
`max_attempts`. On the final failure it is moved into `webhook_deliveries_dlq` and
removed from the live table.

The DLQ table mirrors every delivery column and adds: `last_error` (the failure
that exhausted retries), `failed_at`, `original_id` (trace back to the live row),
`replayed_at` and `replay_delivery_id` (audit trail + double-replay guard).

### Why `payload` is `bytea`

The HMAC-SHA256 signature is computed over the **exact** request body bytes. If we
stored the payload as `jsonb` (or re-serialized text), Postgres/JS could reorder
keys or change whitespace, and the recomputed body would no longer match the
signature — replay would deliver a body the subscriber rejects. Storing raw bytes,
plus the original signature string, guarantees a replayed request is
byte-identical and validly signed.

## Endpoints

All routes require a Bearer JWT whose `role` claim is `admin`.

### `GET /api/webhooks`

Returns live webhook deliveries newest first. Pagination is cursor based over
`createdAt DESC, id DESC`, so paging remains stable while new deliveries are
created between requests.

#### Query parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | integer string | `20` | Items per page. Clamped to `[1, 100]`. Non-numeric values return `400`. |
| `cursor` | string | _(none)_ | Opaque page token from a previous response. Empty string returns `400`. |

#### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "eventId": "evt_abc123",
      "eventType": "market.resolved",
      "targetUrl": "https://subscriber.example/hook",
      "payloadBase64": "c2lnbmVkLWJvZHk=",
      "signature": "sha256=abc...",
      "headers": null,
      "status": "pending",
      "attempts": 0,
      "maxAttempts": 5,
      "lastError": null,
      "nextAttemptAt": "2026-07-25T01:00:00.000Z",
      "createdAt": "2026-07-25T01:00:00.000Z",
      "updatedAt": "2026-07-25T01:00:00.000Z"
    }
  ],
  "nextCursor": "eyJ..."
}
```

Invalid query parameters return `{ "error": { "code": "validation_error",
"message": "...", "requestId": "..." } }`.

### `GET /api/admin/webhooks/dlq` (dedicated list endpoint)

**File:** `src/routes/admin/webhooks/dlq.ts`

Returns a paginated, newest-first list of dead-lettered deliveries for operator
review. This is the primary endpoint for browsing the DLQ — it adds Zod input
validation, structured pino logging with correlation IDs, and per-token rate
limiting on top of the base store query.

**Auth:** `Authorization: Bearer <jwt>` with `{ role: "admin" }`  
**Rate limit:** 60 requests per minute per admin token

#### Query parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | integer string | `20` | Items per page. Clamped to `[1, 100]`. Non-numeric values return `400`. |
| `cursor` | string | _(none)_ | Opaque page token from a previous response. Empty string returns `400`. |

#### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "originalId": "uuid",
      "eventId": "evt_abc123",
      "eventType": "market.resolved",
      "targetUrl": "https://subscriber.example/hook",
      "payloadBase64": "eyJtYXJrZXQiOiJtMSJ9",
      "signature": "sha256=abc…",
      "headers": null,
      "attempts": 5,
      "maxAttempts": 5,
      "lastError": "non-2xx response: 503",
      "failedAt": "2026-07-23T17:00:00.000Z",
      "replayedAt": null,
      "replayDeliveryId": null
    }
  ],
  "nextCursor": "eyJ2MSI6Ijx…"
}
```

`nextCursor` is `null` on the last page. Pass it as `?cursor=` on the next
request. Pagination is keyset-based (`ORDER BY failed_at DESC, id DESC`), so
results stay stable while the DLQ is being actively written to or drained.

`payloadBase64` is the original signed request body, base64-encoded. Decode it to
recover the exact bytes that were (or will be) sent to the subscriber.

#### Error responses

| Status | `error.code` | Cause |
| --- | --- | --- |
| `400` | `validation_error` | Non-numeric `limit` or empty `cursor` |
| `403` | `forbidden` | Missing, invalid, or non-admin JWT |
| `429` | `rate_limit_exceeded` | 60 req/min per token exceeded |
| `500` | _(propagated)_ | Unexpected store error |

#### Structured log events emitted

| Event | Level | Fired when |
| --- | --- | --- |
| `dlq_list_requested` | `info` | Valid request received, before store query |
| `dlq_list_returned` | `info` | Response ready, includes `count` + `hasNextPage` |
| `dlq_list_validation_failed` | `warn` | Zod validation rejected query params |
| `dlq_list_error` | `error` | Unexpected store error |

Every log entry includes `requestId` (from `AsyncLocalStorage`) and
`adminAddress` (from the verified JWT subject).

#### Example

```bash
# First page
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/api/admin/webhooks/dlq?limit=10"

# Next page
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/api/admin/webhooks/dlq?limit=10&cursor=eyJ2MSI6..."
```

Query params: `limit` (1–100, default 20), `cursor` (opaque, from a previous
response). Returns:

```json
{
  "data": [
    {
      "id": "…", "originalId": "…", "eventId": "…", "eventType": "market.resolved",
      "targetUrl": "https://…", "payloadBase64": "…", "signature": "…",
      "headers": null, "attempts": 5, "maxAttempts": 5,
      "lastError": "non-2xx response: 503", "failedAt": "2026-…Z",
      "replayedAt": null, "replayDeliveryId": null
    }
  ],
  "nextCursor": "eyJ…"   // null on the last page
}
```

Pagination is keyset-based (`ORDER BY failed_at DESC, id DESC`), so listings stay
correct while the DLQ is being written to or drained. Payload bytes are returned
base64-encoded, never raw.

### `POST /api/admin/webhooks/dlq/:id/replay`

Re-enqueues a dead-lettered delivery as a **fresh** live delivery with
`attempts = 0`, reusing the stored payload bytes and signature.

| Outcome | Status |
| --- | --- |
| Replay accepted, fresh delivery queued | `202` `{ data: { deliveryId, status, attempts } }` |
| Malformed id | `400` |
| Unknown id | `404` |
| Row already replayed | `409` `{ error: { code: "already_replayed" }, replayDeliveryId }` |
| Caller not authenticated | `401` |
| Caller not an admin | `403` |

## Guarantees

- **Exactly-once dead-lettering.** `moveToDlq` inserts the DLQ row and deletes the
  live row in one transaction, selecting the live row `FOR UPDATE`. If it's already
  gone (a concurrent worker dead-lettered it), the call is a no-op — never a
  duplicate.
- **Idempotent replay.** `markReplayed` is a conditional update that only fires
  while `replayed_at IS NULL`. A lost race rolls back the fresh delivery, so one
  DLQ row yields at most one redelivery.
- **Faithful replay.** Original signed body bytes + signature are stored and reused
  verbatim.

## Running locally

```bash
npm install
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, WEBHOOK_SIGNING_SECRET
npm run db:migrate            # or: psql "$DATABASE_URL" -f drizzle/0001_webhook_dlq.sql
npm run dev
npm test                      # in-memory store; no Postgres required
```

## Testing notes

- `tests/webhookDispatcher.test.ts` — unit tests: success, retry→exhaust→DLQ,
  exactly-once dead-lettering, and replay (attempts reset, bytes + signature
  preserved, idempotent).
- `tests/adminWebhooks.test.ts` — end-to-end over HTTP: auth (401/403), cursor
  pagination across pages, and the full "failing target → DLQ → replay (202) →
  redelivery succeeds" flow, plus 404/400/409 edge cases.
- `tests/adminDlq.test.ts` — **focused tests for the dedicated DLQ list endpoint**:
  auth (403 for missing/bad/non-admin tokens), empty list, cursor pagination
  (no overlap, last-page null cursor, newest-first order), limit clamping
  (default 20, clamp to 100, clamp to 1), invalid query params (non-numeric
  limit, empty cursor → 400), payload base64 round-trip, all response fields
  present, structured log events (`dlq_list_requested`, `dlq_list_returned`,
  `dlq_list_validation_failed`), route isolation (404 when deps not injected),
  rate-limit headers. All 26 tests pass against `InMemoryWebhookStore`.

Tests run against `InMemoryWebhookStore`, so no database is needed in CI. The
`DrizzleWebhookStore` is a thin CRUD/transaction wrapper over the same interface;
its transaction semantics map directly to the in-memory behaviour the tests pin
down, and it is exercised against a real Postgres in a deployed environment.
