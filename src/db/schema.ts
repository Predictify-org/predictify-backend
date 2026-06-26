import { pgTable, uuid, text, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";

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
  version: integer("version").notNull().default(1),
});

export const marketAuditLog = pgTable("market_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  adminAddress: text("admin_address").notNull(),
  action: text("action").notNull(),
  beforeState: jsonb("before_state").notNull(),
  afterState: jsonb("after_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
