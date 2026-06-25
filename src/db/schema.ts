import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  stellarAddress: text("stellar_address").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const markets = pgTable("markets", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  status: text("status").notNull(),
  resolutionTime: timestamp("resolution_time", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
  indexedLedger: integer("indexed_ledger").notNull(),
  archived: boolean("archived").notNull().default(false),
});

export const predictions = pgTable("predictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  outcome: text("outcome").notNull(),
  amount: text("amount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per on-chain Soroban event seen for the Predictify contract.
// The unique index on (ledger, tx_hash, op_index) is the deduplication
// key used for both normal re-ingestion and post-reorg re-ingest.
export const indexerEvents = pgTable(
  "indexer_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // RPC paging cursor – kept for debugging / re-play queries
    eventId: text("event_id").notNull(),
    ledger: integer("ledger").notNull(),
    txHash: text("tx_hash").notNull(),
    // Position of the event within the transaction
    opIndex: integer("op_index").notNull(),
    contractId: text("contract_id").notNull(),
    // XDR-encoded topic segments stored as a JSON array of base64 strings
    topicXdr: jsonb("topic_xdr").notNull().$type<string[]>(),
    // XDR-encoded event value (base64)
    valueXdr: text("value_xdr").notNull(),
    ledgerClosedAt: timestamp("ledger_closed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventKey: uniqueIndex("indexer_events_ledger_tx_op_idx").on(
      t.ledger,
      t.txHash,
      t.opIndex,
    ),
  }),
);
