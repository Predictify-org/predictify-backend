# Audit Log API — Cursor Pagination

`GET /api/admin/audit` returns audit log entries ordered by `(created_at DESC, id DESC)` with opaque keyset cursor pagination. This document explains the ordering contract, why a composite cursor is necessary, and how to page through results correctly.

## Why `(created_at, id)` and not just `created_at`

A `ORDER BY created_at DESC` alone is **not stable** when multiple rows share the same millisecond timestamp — which is routine under concurrent writes (e.g. a burst of audit events from a batch admin operation or multiple simultaneous requests). Postgres makes no guarantee about the relative order of ties, so a single-column sort can return different orderings on repeated executions, causing a page boundary to **skip or duplicate rows**.

Adding `id DESC` as a tie-breaker makes the sort key `(created_at, id)` globally unique and deterministic. The backing database index `audit_logs_created_at_id_idx` covers exactly this pair:

```sql
CREATE INDEX audit_logs_created_at_id_idx
  ON audit_logs (created_at DESC, id DESC);
```

## How the cursor works

The cursor encodes the `(created_at, id)` of the **last row on the current page**. On the next request it is decoded into a keyset predicate:

```sql
WHERE (created_at < :cursor_ts)
   OR (created_at = :cursor_ts AND id < :cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT :limit + 1   -- one extra row for the "has more" check
```

The `OR` branches correspond to two cases:

| Case | Meaning |
|------|---------|
| `created_at < cursor_ts` | The next row has an older timestamp — the common case. |
| `created_at = cursor_ts AND id < cursor_id` | The next row shares the same timestamp; the `id` tie-breaker selects the correct continuation point. |

## Paging example

```
GET /api/admin/audit?limit=2
→ { data: [{id:"e", ...}, {id:"d", ...}], nextCursor: "eyJ...A" }

GET /api/admin/audit?limit=2&cursor=eyJ...A
→ { data: [{id:"c", ...}, {id:"b", ...}], nextCursor: "eyJ...B" }

GET /api/admin/audit?limit=2&cursor=eyJ...B
→ { data: [{id:"a", ...}], nextCursor: null }
```

All five rows are returned exactly once, even if all five share the same `created_at` timestamp.

## Cursor format

Cursors are **opaque** base64url strings. Their internal encoding is versioned and may change between releases. Never construct a cursor manually — always use the `nextCursor` value returned by the API. A missing or invalid cursor is treated as "start from the beginning" (first page).

## Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cursor` | string | Opaque cursor from the previous page's `nextCursor`. Omit for the first page. |
| `limit` | integer | Rows per page. Defaults to 20, capped at 100. |
| `action` | string | Exact-match filter on the `action` field. |
| `actor` | string | Exact-match filter on `wallet_address`. |
| `startDate` | ISO 8601 | Include rows with `created_at >= startDate`. |
| `endDate` | ISO 8601 | Include rows with `created_at <= endDate`. |

## Stream export

`GET /api/admin/audit/export` streams all matching rows as NDJSON, also ordered `(created_at DESC, id DESC)`. This endpoint does not paginate — it streams the full result set up to the configured `maxRecords` limit (default 100 000). Use filters (`startDate`, `endDate`, `action`, `actor`) to narrow the export.

## Migration

Migration `0025_audit_logs_cursor_index.sql` applied the following change:

```sql
-- Replaced:
DROP INDEX IF EXISTS audit_logs_created_at_idx;

-- With:
CREATE INDEX IF NOT EXISTS audit_logs_created_at_id_idx
  ON audit_logs (created_at DESC, id DESC);
```

The old single-column index is superseded by the composite index, which covers the same queries and additionally accelerates the cursor tie-breaker predicate.

## See also

- [`src/repositories/auditLogRepo.ts`](../src/repositories/auditLogRepo.ts) — keyset predicate implementation
- [`src/utils/cursor.ts`](../src/utils/cursor.ts) — cursor encode/decode
- [`drizzle/migrations/0025_audit_logs_cursor_index.sql`](../drizzle/migrations/0025_audit_logs_cursor_index.sql) — migration
- [`tests/auditLogCursorStability.test.ts`](../tests/auditLogCursorStability.test.ts) — cursor stability tests
