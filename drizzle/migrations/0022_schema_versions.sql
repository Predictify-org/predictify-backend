-- Migration: schema_versions table + checksums
--
-- Tracks every applied migration by recording the migration name, the
-- SHA-256 checksum of its SQL content, and the timestamp at which it was
-- applied. This allows drift detection: if a previously-applied migration
-- file is modified on disk, the stored checksum will no longer match.
--
-- Design decisions:
--   • `version`      — the file-system migration tag (e.g. "0001_add_users").
--                      TEXT PRIMARY KEY so it is both unique and self-documenting.
--   • `checksum`     — hex-encoded SHA-256 of the raw migration SQL content.
--                      64 characters, always stored lower-case.
--   • `applied_at`   — timestamptz; when the migration runner first recorded this row.
--   • `applied_by`   — optional; identity of the agent/process that applied it
--                      (useful for multi-tenant or CI audit trails).
--
-- All statements use IF NOT EXISTS so re-running the migration is idempotent.

CREATE TABLE IF NOT EXISTS schema_versions (
  version     text        PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text,

  -- checksum must be a 64-char lowercase hex string (SHA-256)
  CONSTRAINT schema_versions_checksum_format
    CHECK (checksum ~ '^[0-9a-f]{64}$')
);

-- Fast lookup by apply-time for chronological audits.
CREATE INDEX IF NOT EXISTS schema_versions_applied_at_idx
  ON schema_versions (applied_at DESC);
