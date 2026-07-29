-- Migration: Fraud signal detector
--
-- 1. Adds an optional `funding_source` column to predictions so the graph
--    builder can connect addresses that share an on-chain funder.
--    Nullable + no default — fully backwards-compatible with existing rows.
-- 2. Creates the `fraud_flags` table that the background detector writes
--    cluster findings into, with the reason payload and review state.
--
-- All statements are idempotent so re-running the migration is safe.

ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS funding_source text;

CREATE INDEX IF NOT EXISTS predictions_funding_source_idx
  ON predictions (funding_source)
  WHERE funding_source IS NOT NULL;

CREATE TABLE IF NOT EXISTS fraud_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stellar_address text NOT NULL,
  reason          text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  score           integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'open',
  reviewed_by     text,
  reviewed_at     timestamptz,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fraud_flags_status_check
    CHECK (status IN ('open', 'dismissed', 'confirmed'))
);

-- One open flag per (cluster, user) to keep re-runs idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS fraud_flags_cluster_user_unique
  ON fraud_flags (cluster_key, user_id);

CREATE INDEX IF NOT EXISTS fraud_flags_status_created_idx
  ON fraud_flags (status, created_at DESC);

CREATE INDEX IF NOT EXISTS fraud_flags_address_idx
  ON fraud_flags (stellar_address);
