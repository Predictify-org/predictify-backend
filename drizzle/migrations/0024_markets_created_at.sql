-- Migration: 0024_markets_created_at
-- Adds created_at column to the markets table for cursor-based pagination.

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Index for efficient cursor pagination ordering on (created_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS markets_created_at_id_idx
  ON markets (created_at DESC, id DESC);

-- Backfill created_at for existing rows using the current timestamp.
UPDATE markets SET created_at = now() WHERE created_at IS NULL;
