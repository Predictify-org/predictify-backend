-- up
-- Supports the optional enabled filter used by GET /api/feature-flags.
-- Keeping this as a standalone migration makes the plan easy to verify with
-- EXPLAIN and lets operators roll it back independently.
CREATE INDEX IF NOT EXISTS feature_flags_enabled_idx
  ON feature_flags (enabled);

-- down
DROP INDEX IF EXISTS feature_flags_enabled_idx;
