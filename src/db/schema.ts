import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, type AnyPgColumn } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  stellarAddress: text("stellar_address").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authChallenges = pgTable("auth_challenges", {
  nonce: text("nonce").primaryKey(),
  stellarAddress: text("stellar_address").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: uuid("family_id").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => refreshTokens.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Webhook tables
// ---------------------------------------------------------------------------

/**
 * Stores a subscriber's endpoint configuration. The `secret` field holds a
 * random 32-byte hex string that is used to compute the HMAC-SHA256 signature
 * sent with every delivery.  `events` is an array of event-type strings the
 * subscriber wants to receive (e.g. ["market.resolved", "dispute.opened"]).
 */
export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Destination URL for POST delivery */
  url: text("url").notNull(),
  /** Hex-encoded 32-byte HMAC secret — never returned to the client */
  secret: text("secret").notNull(),
  /** JSON array of subscribed event types */
  events: jsonb("events").notNull().default([]),
  /** Whether this subscription is currently active */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tracks each individual delivery attempt.  One logical event dispatch may
 * create many rows here as retries accumulate.
 *
 * Status lifecycle:
 *   pending → delivering → success
 *                        ↓ (on 5xx / timeout)
 *                       failed → pending (rescheduled)
 *                              → terminal  (after 5 attempts)
 *                              → dlq       (moved to dead-letter queue)
 */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id),
  /** Arbitrary event type string, e.g. "market.resolved" */
  eventType: text("event_type").notNull(),
  /** Raw JSON payload that will be (re)sent on every attempt */
  payload: jsonb("payload").notNull(),
  /**
   * Current lifecycle state:
   *   - pending:    waiting to be picked up by the worker
   *   - delivering: currently being attempted (prevents duplicate pickup)
   *   - success:    received a 2xx response
   *   - failed:     last attempt was non-2xx / timeout, will be retried
   *   - terminal:   exhausted all retries (5 failed attempts)
   *   - dlq:        moved to dead-letter queue for manual review
   */
  status: text("status").notNull().default("pending"),
  /** Number of delivery attempts made so far */
  attempt: integer("attempt").notNull().default(0),
  /** Timestamp after which the next retry is allowed */
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
  /** HTTP status code of the last attempt (null if not yet attempted) */
  lastStatusCode: integer("last_status_code"),
  /** Truncated response body or error message from the last attempt */
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const markets = pgTable("markets", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  status: text("status").notNull(),
  resolutionOutcome: text("resolution_outcome"),
  resolutionTime: timestamp("resolution_time", { withTimezone: true }).notNull(),
  /** Populated atomically when the market_resolved on-chain event is processed. */
  winningOutcome: text("winning_outcome"),
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
  status: text("status").notNull().default("pending"),
  /** Set to "won" or "lost" in the same transaction that resolves the parent market. */
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Stores idempotency keys for POST/PATCH mutation replay.
 * Rows are purged after 24 h by the sweeper job.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    key: text("key").primaryKey(),
    /** sha256 hex of the request body at first call */
    fingerprint: text("fingerprint").notNull(),
    /** HTTP status code of the original response */
    responseStatus: integer("response_status").notNull(),
    /** Serialised response body */
    responseBody: jsonb("response_body").notNull(),
    /** Optional headers to replay (e.g. Location) */
    responseHeaders: jsonb("response_headers").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({ idempotencyExpiresIdx: index("idempotency_expires_idx").on(t.expiresAt) }),
);
