# Admin Reindex Endpoint

`POST /api/admin/reindex` triggers a backfill of on-chain Predictify contract
events from a caller-supplied ledger sequence number up to the **current
Soroban RPC chain tip**. It is the primary operator lever for healing gaps
in the `indexer_events` table after RPC outages, node restarts, or manual
data corrections.

---

## Authentication

Requires a valid admin JWT in the `Authorization` header:

```
Authorization: Bearer <jwt>
```

The JWT must be signed with a key from the key ring (`src/utils/keyRing.ts`)
and carry `{ role: "admin" }`. The subject (`sub`) is recorded in the audit
log as the operator identity. Any request without a valid admin token returns
**403 Forbidden**.

---

## Rate Limiting

60 requests per minute per admin token (same window as all other admin
endpoints). The bucket is keyed on the raw `Authorization` header so multiple
admin tokens do not share quota. Exceeded requests receive:

```json
HTTP 429 Too Many Requests
{ "error": { "code": "rate_limit_exceeded" } }
```

---

## Request

```
POST /api/admin/reindex
Content-Type: application/json
Authorization: Bearer <admin-jwt>
```

### Body

| Field | Type | Required | Description |
|---|---|---|---|
| `ledger` | `integer` | ✅ | Starting ledger sequence number (inclusive). Must be ≥ 1. |

#### Example

```json
{ "ledger": 54321 }
```

---

## Response

### 200 OK — Reindex triggered

Returns the resolved ledger range (`from` as supplied, `to` as the chain tip
at request time).

```json
{
  "data": {
    "from": 54321,
    "to":   55000
  }
}
```

The `x-request-id` response header carries the correlation ID so log lines
from the backfill can be traced directly to this request:

```
x-request-id: <correlation-id>
```

### 400 Bad Request — Validation error

```json
{
  "error": {
    "code": "validation_error",
    "details": [ ... ],
    "requestId": "<id>"
  }
}
```

Returned when `ledger` is missing, not an integer, or < 1.

### 403 Forbidden

```json
{ "error": { "code": "forbidden" } }
```

### 429 Too Many Requests

```json
{ "error": { "code": "rate_limit_exceeded" } }
```

### 500 Internal Server Error

Returned when Soroban RPC is unreachable (`getChainTip` fails) or the
database write fails. The error envelope includes the correlation ID so
you can grep the pino logs:

```json
{
  "error": {
    "code": "internal_error",
    "message": "Internal error",
    "correlationId": "<id>"
  }
}
```

---

## How It Works

1. **Validate** — Zod checks that `ledger` is a positive integer.
2. **Resolve tip** — Calls `indexerService.getChainTip()` (Soroban RPC
   `getLatestLedger`). If RPC is down the request fails immediately with 500.
3. **Backfill** — Calls `indexerService.backfillRange(from, to)`. Work is
   chunked by `INDEXER_BACKFILL_CHUNK_SIZE` (default 1 000 ledgers per
   chunk). Each chunk fetches events from Soroban RPC and upserts them with
   `ON CONFLICT (ledger, tx_hash, op_index) DO NOTHING` — re-runs are safe.
4. **Reorg overlap** — `backfillRange` rewinds by `INDEXER_REWIND_LEDGERS`
   (default 10) so recently-reorganised ledgers are always re-fetched.
5. **Cursor advance** — After all chunks are written, the indexer cursor is
   advanced to `to` via an `INSERT … ON CONFLICT DO UPDATE SET last_ledger =
   GREATEST(…)` so normal polling resumes from the new tip.
6. **Audit log** — A row is inserted into `audit_logs` with
   `action = "admin.reindex"`, the admin's Stellar address, the caller IP,
   and the correlation ID.
7. **Prometheus** — `admin_reindex_total` is incremented once.

**Note:** Steps 6 and 7 only execute if the backfill succeeds. A failed
backfill produces no audit row and no counter increment.

---

## Observability

### Structured log (pino)

```json
{
  "level": "info",
  "msg":   "admin reindex triggered",
  "requestId": "<id>",
  "adminAddress": "G...",
  "from": 54321,
  "to":   55000
}
```

### Prometheus counter

```
admin_reindex_total
```

Scrape via `/metrics` (requires `METRICS_AUTH_TOKEN` if set).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `INDEXER_BACKFILL_CHUNK_SIZE` | `1000` | Ledgers per backfill chunk |
| `INDEXER_REWIND_LEDGERS` | `10` | Overlap applied for reorg safety |
| `SOROBAN_RPC_URL` | testnet | Soroban RPC endpoint for `getChainTip` |

---

## Safety Notes

- **Idempotent** — Re-running the same range is safe. Duplicate events are
  silently ignored by the `ON CONFLICT DO NOTHING` upsert.
- **No data loss** — The backfill only *inserts*; existing rows are never
  deleted or updated.
- **Long-running** — For large ledger ranges the HTTP request will block until
  the backfill completes. For very large gaps (thousands of ledgers) consider
  running `npm run indexer:gap-scan` instead, which is purpose-built for
  bulk healing.
- **Concurrency** — Running two simultaneous reindex operations over the same
  range is safe (idempotent inserts), but wasteful. Serialise admin triggers
  if possible.

---

## Examples

### Reindex the last 500 ledgers

```bash
# 1. Get the current chain tip
TIP=$(curl -s http://localhost:3000/healthz/dependencies | jq .indexer.tip)
FROM=$((TIP - 500))

# 2. Trigger reindex
curl -X POST http://localhost:3000/api/admin/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"ledger\": $FROM}"
```

### Reindex from a known checkpoint

```bash
curl -X POST http://localhost:3000/api/admin/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: reindex-incident-2026-07-20" \
  -d '{"ledger": 50000}'
```
