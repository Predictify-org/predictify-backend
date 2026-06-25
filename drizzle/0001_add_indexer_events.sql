-- Migration: add indexer_events table
--
-- Stores every on-chain Soroban event seen for the Predictify contract.
-- The unique index on (ledger, tx_hash, op_index) is the deduplication key:
--   INSERT ... ON CONFLICT DO NOTHING silently drops re-ingested duplicates,
--   and the same index makes orphan detection efficient during reorg handling.

CREATE TABLE IF NOT EXISTS "indexer_events" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RPC paging cursor kept for debugging and re-play queries
  "event_id"         text        NOT NULL,
  "ledger"           integer     NOT NULL,
  "tx_hash"          text        NOT NULL,
  -- Zero-based position of the event within the transaction
  "op_index"         integer     NOT NULL,
  "contract_id"      text        NOT NULL,
  -- XDR-encoded topic segments as a JSON array of base64 strings
  "topic_xdr"        jsonb       NOT NULL,
  -- XDR-encoded event value (base64)
  "value_xdr"        text        NOT NULL,
  "ledger_closed_at" timestamptz NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

-- Deduplication + reorg-detection index
CREATE UNIQUE INDEX IF NOT EXISTS "indexer_events_ledger_tx_op_idx"
  ON "indexer_events" ("ledger", "tx_hash", "op_index");
