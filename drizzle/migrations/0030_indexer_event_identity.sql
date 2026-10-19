ALTER TABLE "indexer_events" ADD COLUMN IF NOT EXISTS "tx_application_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "indexer_events" ADD COLUMN IF NOT EXISTS "event_index" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "indexer_events" SET "event_index" = 0 WHERE "event_index" IS NULL;
--> statement-breakpoint
UPDATE "indexer_events" SET "tx_application_order" = 0 WHERE "tx_application_order" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "indexer_events_identity_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "indexer_events_identity_idx" ON "indexer_events" ("ledger", "tx_hash", "op_index", "event_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "indexer_events_position_idx" ON "indexer_events" ("ledger", "tx_application_order", "op_index", "event_index");
--> statement-breakpoint
ALTER TABLE "indexer_reorgs" ADD COLUMN IF NOT EXISTS "tx_application_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "indexer_reorgs" ADD COLUMN IF NOT EXISTS "event_index" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "indexer_reorgs" ADD COLUMN IF NOT EXISTS "repaired_predictions" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "indexer_reorgs_position_idx" ON "indexer_reorgs" ("ledger", "tx_application_order", "op_index", "event_index");
