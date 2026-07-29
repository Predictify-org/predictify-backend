-- schema_versions.sql
--
-- Standalone DDL reference for the `schema_versions` table.
-- The canonical migration is drizzle/migrations/0022_schema_versions.sql.
-- This file documents the table design for reviewers and tooling.
--
-- Purpose:
--   Record every applied Drizzle migration together with its SHA-256
--   checksum, enabling drift detection when migration files change after
--   they have been applied to a database.
--
-- Columns:
--   version    — migration tag (e.g. "0001_add_users"), primary key.
--   checksum   — hex SHA-256 of the migration SQL file at apply time.
--   applied_at — when the row was written (defaults to now()).
--   applied_by — optional; CI job name, user, or process identity.

CREATE TABLE IF NOT EXISTS schema_versions (
  version     text        PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text,

  CONSTRAINT schema_versions_checksum_format
    CHECK (checksum ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS schema_versions_applied_at_idx
  ON schema_versions (applied_at DESC);
