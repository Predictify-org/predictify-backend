import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";

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

export const predictions = pgTable(
  "predictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: text("market_id").notNull().references(() => markets.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    outcome: text("outcome").notNull(),
    amount: text("amount").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("user_status_idx").on(
      table.userId,
      table.status,
      desc(table.createdAt),
      table.id
    ),
  })
);

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
