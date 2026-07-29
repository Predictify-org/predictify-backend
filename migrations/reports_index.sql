-- up
-- Compound index for the scheduled reports list hot path.
-- The GET /api/reports/scheduled endpoint queries by user_id with ORDER BY created_at DESC.
-- This index covers both filter and sort in a single btree scan, avoiding a separate sort step.
CREATE INDEX IF NOT EXISTS scheduled_reports_user_created_at_idx
  ON scheduled_reports (user_id, created_at DESC);

-- down
DROP INDEX IF EXISTS scheduled_reports_user_created_at_idx;