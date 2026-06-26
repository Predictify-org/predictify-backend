import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, unique } from "drizzle-orm/pg-core";

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
  txHash: text("tx_hash").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueUserMarketTx: unique().on(table.userId, table.marketId, table.txHash),
}));

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexerEvents = pgTable("indexer_events", {
  id: serial("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  eventType: text("event_type").notNull(),
  data: jsonb("data"),
  ledger: integer("ledger").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IndexerEvent = typeof indexerEvents.$inferSelect;
export type NewIndexerEvent = typeof indexerEvents.$inferInsert;
