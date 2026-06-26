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
  resolutionOutcome: text("resolution_outcome"),
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
  txHash: text("tx_hash").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueUserMarketTx: unique().on(table.userId, table.marketId, table.txHash),
}));

// Winnings claims submitted by users after a market resolves in their favour
export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  marketId: text("market_id").notNull().references(() => markets.id),
  amount: text("amount").notNull(),
  // pending | paid | rejected
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Resolution disputes raised by users who disagree with an outcome
export const disputes = pgTable("disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  marketId: text("market_id").notNull().references(() => markets.id),
  reason: text("reason").notNull(),
  // open | resolved | rejected
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable record of every admin read/write on user data
export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminAddress: text("admin_address").notNull(),
  action: text("action").notNull(),
  targetAddress: text("target_address").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per on-chain Soroban event seen for the Predictify contract.
// Unique index on (ledger, tx_hash, op_index) is the deduplication key.
export const indexerEvents = pgTable(
  "indexer_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    ledger: integer("ledger").notNull(),
    txHash: text("tx_hash").notNull(),
    opIndex: integer("op_index").notNull(),
    contractId: text("contract_id").notNull(),
    topicXdr: jsonb("topic_xdr").notNull().$type<string[]>(),
    valueXdr: text("value_xdr").notNull(),
    ledgerClosedAt: timestamp("ledger_closed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventKey: uniqueIndex("indexer_events_ledger_tx_op_idx").on(t.ledger, t.txHash, t.opIndex),
  }),
);
