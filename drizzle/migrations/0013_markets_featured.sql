-- Migration: Add featured curation columns to markets for the home page.
-- Tracks whether a market has been curated by an admin, when, and by whom.

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS featured_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS featured_by text;

-- Partial index: only featured rows are read on the home page, so a btree
-- over the descending featured_at (NULLs last) keeps the home-page query O(log n).
CREATE INDEX IF NOT EXISTS markets_featured_at_idx
  ON markets (featured_at DESC NULLS LAST)
  WHERE featured = true;
