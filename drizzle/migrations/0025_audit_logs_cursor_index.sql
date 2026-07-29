-- Migration: 0025_audit_logs_cursor_index
-- Replaces the single-column audit_logs_created_at_idx with a composite
-- (created_at DESC, id DESC) index so that keyset-cursor pagination on
-- GET /api/admin/audit is stable under concurrent inserts.
--
-- When two rows share the same created_at timestamp (common under high write
-- concurrency) the previous single-column index left the tie-breaking order
-- non-deterministic, meaning a page boundary could skip or repeat rows.
-- The composite index makes (created_at, id) the canonical sort key, matching
-- the ORDER BY and cursor predicate already used in auditLogRepo.ts.

-- Drop the old single-column index (no longer needed).
DROP INDEX IF EXISTS audit_logs_created_at_idx;

-- Create the composite covering index used by the keyset cursor predicate:
--   WHERE (created_at < $cursor_ts)
--      OR (created_at = $cursor_ts AND id < $cursor_id)
--   ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS audit_logs_created_at_id_idx
  ON audit_logs (created_at DESC, id DESC);
