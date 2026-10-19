-- Migration: user-signed claim_winnings prepare/submit flow.
-- Adds the columns the prepare/submit state machine needs on `claims`
-- (prepared -> submitting -> paid | failed | expired) and a partial unique
-- index allowing at most one non-terminal claim per (user, market).

ALTER TABLE "claims"
  ADD COLUMN IF NOT EXISTS "claim_nonce" text,
  ADD COLUMN IF NOT EXISTS "expected_tx_hash" text,
  ADD COLUMN IF NOT EXISTS "prepared_xdr" text,
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "error_code" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claims_one_active_per_user_market_idx"
  ON "claims" ("user_id", "market_id")
  WHERE "status" in ('prepared', 'submitting', 'paid');
