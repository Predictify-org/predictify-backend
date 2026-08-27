ALTER TABLE "indexer_events" ADD COLUMN IF NOT EXISTS "canonical" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
DELETE FROM "indexer_events" duplicate
USING "indexer_events" original
WHERE duplicate."ledger" = original."ledger"
  AND duplicate."tx_hash" = original."tx_hash"
  AND duplicate."op_index" = original."op_index"
  AND duplicate."id" > original."id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "indexer_events_identity_idx" ON "indexer_events" ("ledger", "tx_hash", "op_index");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indexer_reorgs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ledger" integer NOT NULL,
  "op_index" integer NOT NULL,
  "old_tx_hash" text NOT NULL,
  "new_tx_hash" text NOT NULL,
  "status" text DEFAULT 'detected' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "indexer_reorgs_ledger_idx" ON "indexer_reorgs" ("ledger", "op_index");
