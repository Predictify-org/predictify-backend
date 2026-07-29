-- Migration: add confirm_attempts and last_error columns to predictions
-- These columns support the predictionsConfirmer worker which transitions
-- pending predictions to confirmed (or failed after max attempts) by joining
-- against indexer_events on txHash.

ALTER TABLE "predictions"
  ADD COLUMN IF NOT EXISTS "confirm_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_error" text;
