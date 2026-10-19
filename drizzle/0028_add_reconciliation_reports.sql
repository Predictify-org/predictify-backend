-- Migration: add reconciliation_reports and reconciliation_discrepancies tables
-- These tables persist nightly and on-demand payout reconciliation runs,
-- tracking discrepancies between winning predictions, claims ledger rows, and indexed win_clm events.

CREATE TABLE IF NOT EXISTS "reconciliation_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fingerprint" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'ok',
  "since" timestamp with time zone,
  "until" timestamp with time zone,
  "total_keys" integer NOT NULL DEFAULT 0,
  "matched_keys" integer NOT NULL DEFAULT 0,
  "unmatched_keys" integer NOT NULL DEFAULT 0,
  "discrepancy_count" integer NOT NULL DEFAULT 0,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "reconciliation_reports_created_at_id_idx"
  ON "reconciliation_reports" ("created_at", "id");

CREATE TABLE IF NOT EXISTS "reconciliation_discrepancies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "report_id" uuid NOT NULL REFERENCES "reconciliation_reports"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "stellar_address" text,
  "market_id" text NOT NULL,
  "prediction_id" uuid,
  "claim_id" uuid,
  "tx_hash" text,
  "db_amount" text,
  "on_chain_amount" text,
  "difference" text,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "reconciliation_discrepancies_report_id_idx"
  ON "reconciliation_discrepancies" ("report_id");

CREATE INDEX IF NOT EXISTS "reconciliation_discrepancies_kind_idx"
  ON "reconciliation_discrepancies" ("kind");

CREATE INDEX IF NOT EXISTS "reconciliation_discrepancies_report_kind_idx"
  ON "reconciliation_discrepancies" ("report_id", "kind");
