import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stellarAddress: text("stellar_address").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * Composite index for GET /api/users keyset (cursor) pagination.
     *
     * The query orders by (created_at DESC, id DESC); without this index
     * PostgreSQL falls back to a sequential scan + quicksort — O(n) I/O.
     * With this index the planner uses an Index Scan Backward, reducing I/O
     * to O(log n + page_size) and eliminating the sort node entirely.
     *
     * Created by migration 0025_users_filter_idx (CONCURRENTLY, no table lock).
     * Rollback: DROP INDEX CONCURRENTLY IF EXISTS users_created_at_id_idx;
     */
    usersCreatedAtIdIdx: index("users_created_at_id_idx").on(
      t.createdAt,
      t.id,
    ),
  }),
);

export const authChallenges = pgTable("auth_challenges", {
  nonce: text("nonce").primaryKey(),
  stellarAddress: text("stellar_address").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: uuid("family_id").notNull(),
  parentId: uuid("parent_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: jsonb("events").notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookDeliveriesDlq = pgTable("webhook_deliveries_dlq", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("dlq"),
  attempt: integer("attempt").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const markets = pgTable("markets", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  status: text("status").notNull(),
  resolutionOutcome: text("resolution_outcome"),
  resolutionTime: timestamp("resolution_time", {
    withTimezone: true,
  }).notNull(),
  winningOutcome: text("winning_outcome"),
  metadata: jsonb("metadata"),
  indexedLedger: integer("indexed_ledger").notNull(),
  archived: boolean("archived").notNull().default(false),
  version: integer("version").notNull().default(1),
  featured: boolean("featured").notNull().default(false),
  featuredAt: timestamp("featured_at", { withTimezone: true }),
  featuredBy: text("featured_by"),
  forceFinalized: boolean("force_finalized").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const marketAuditLog = pgTable("market_audit_log", {
  marketId: text("market_id")
    .notNull()
    .references(() => markets.id),
  adminAddress: text("admin_address").notNull(),
  action: text("action").notNull(),
  beforeState: jsonb("before_state").notNull(),
  afterState: jsonb("after_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const predictions = pgTable("predictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id")
    .notNull()
    .references(() => markets.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  outcome: text("outcome").notNull(),
  amount: text("amount").notNull(),
  txHash: text("tx_hash").notNull().default(""),
  /**
   * Optional on-chain funding source (e.g. the account that originally
   * funded this user's wallet). Used by the fraud-signal detector to
   * connect addresses that share a funder. Nullable so legacy rows and
   * predictions whose funder is unknown remain valid.
   */
  fundingSource: text("funding_source"),
  status: text("status").notNull().default("pending"),
  result: text("result"),
  /** Soroban claim transaction hash — populated after the user claims their winnings. */
  claimTxHash: text("claim_tx_hash"),
  /** Timestamp when the claim transaction was submitted. Null until claimed. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Number of confirmation attempts made by the predictionsConfirmer worker.
   * Incremented each tick when no matching indexer event is found.
   * After MAX_CONFIRM_ATTEMPTS (3) the prediction is marked as failed.
   */
  confirmAttempts: integer("confirm_attempts").notNull().default(0),
  /**
   * Error message from the most recent failed confirmation attempt.
   * Set when the prediction transitions to failed after exhausting all attempts.
   */
  lastError: text("last_error"),
});

/**
 * fraud_flags — persisted output of the fraud-signal background job.
 *
 * Each row represents a single (cluster, user) finding. A `cluster_key`
 * groups all addresses the union-find algorithm collapsed together,
 * `reason` is a short machine code, and `evidence` carries the structured
 * payload (graph edges, shared funders, repeated patterns) for admin review.
 *
 * `(cluster_key, user_id)` is unique so re-running the detector is
 * idempotent and never produces duplicates for the same finding.
 */
export const fraudFlags = pgTable(
  "fraud_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterKey: text("cluster_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stellarAddress: text("stellar_address").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    score: integer("score").notNull().default(0),
    status: text("status").notNull().default("open"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    fraudFlagsStatusCreatedIdx: index("fraud_flags_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    fraudFlagsAddressIdx: index("fraud_flags_address_idx").on(t.stellarAddress),
  }),
);

export type FraudFlag = typeof fraudFlags.$inferSelect;

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  marketId: text("market_id")
    .notNull()
    .references(() => markets.id),
  amount: text("amount").notNull(),
  status: text("status").notNull().default("pending"),
  settlementTx: text("settlement_tx"),
  settleAttempts: integer("settle_attempts").notNull().default(0),
  nextSettleAttemptAt: timestamp("next_settle_attempt_at", {
    withTimezone: true,
  }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const disputes = pgTable("disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  openedBy: uuid("opened_by")
    .notNull()
    .references(() => users.id),
  marketId: text("market_id")
    .notNull()
    .references(() => markets.id),
  reason: text("reason").notNull(),
  evidenceUri: text("evidence_uri"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminAddress: text("admin_address").notNull(),
  action: text("action").notNull(),
  targetAddress: text("target_address").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const marketComments = pgTable("market_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id, {
    onDelete: "cascade",
  }),

  authorId: uuid("author_id").references(() => users.id, {
    onDelete: "set null",
  }),
  authorAddress: text("author_address"),

  body: text("body").notNull(),

  moderationFlagged: boolean("moderation_flagged").notNull().default(false),
  moderationReason: text("moderation_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});


/**
 * Stores idempotency keys for POST/PATCH mutation replay.
 * Rows are purged after 24 h by the sweeper job.
 */
export const contractEvents = pgTable("contract_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: text("contract_id").notNull(),
  ledger: integer("ledger").notNull(),
  txHash: text("tx_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const indexerEvents = pgTable("indexer_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ledger: integer("ledger").notNull(),
  txHash: text("tx_hash").notNull(),
  opIndex: integer("op_index").notNull().default(0),
  eventType: text("event_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  marketId: text("market_id"),
  data: jsonb("data"),
});

export type IndexerEvent = typeof indexerEvents.$inferSelect;

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    key: text("key").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    responseHeaders: jsonb("response_headers").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    idempotencyExpiresIdx: index("idempotency_expires_idx").on(t.expiresAt),
  }),
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.category, t.channel] }),
    notificationPreferencesUserIdIdx: index(
      "notification_preferences_user_id_idx",
    ).on(t.userId),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    notificationsUserIdIdx: index("notifications_user_id_idx").on(t.userId),
    notificationsUserIdReadAtIdx: index("notifications_user_id_read_at_idx").on(
      t.userId,
      t.readAt,
    ),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: text("action").notNull(),
    walletAddress: text("wallet_address"),
    ip: text("ip").notNull(),
    correlationId: text("correlation_id").notNull(),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    rateLimitContext: jsonb("rate_limit_context"),
    /** Snapshot of the relevant state immediately before the mutating action. */
    beforeState: jsonb("before_state"),
    /** Snapshot of the relevant state immediately after the mutating action. */
    afterState: jsonb("after_state"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    auditLogsCorrelationIdx: index("audit_logs_correlation_idx").on(
      t.correlationId,
    ),
    // Composite index for stable cursor pagination: ORDER BY created_at DESC, id DESC.
    // The (created_at, id) compound key is unique and monotone, so a keyset cursor
    // over it is stable even when rows with the same timestamp are inserted
    // concurrently — the id tie-breaker ensures no row is skipped or duplicated
    // across page boundaries.
    auditLogsCreatedAtIdIdx: index("audit_logs_created_at_id_idx").on(
      t.createdAt,
      t.id,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Plugins (admin-managed CRUD)
// ---------------------------------------------------------------------------

export const plugins = pgTable("plugins", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Plugin = typeof plugins.$inferSelect;

// ---------------------------------------------------------------------------
// Feature Flags
// ---------------------------------------------------------------------------
export const featureFlags = pgTable("feature_flags", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  variant: text("variant"),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Schema Versions
// ---------------------------------------------------------------------------
/**
 * schema_versions — per-migration checksum registry.
 *
 * Each row tracks a single applied Drizzle migration by recording:
 *   - `version`    — the migration tag (file name without extension), PRIMARY KEY.
 *   - `checksum`   — hex-encoded SHA-256 of the migration SQL at apply time.
 *                    64 lower-case hex characters.
 *   - `appliedAt`  — timestamp at which the row was first written.
 *   - `appliedBy`  — optional identifier for the process/agent that ran the migration
 *                    (CI job name, DB user, etc.).
 *
 * Drift detection: compare stored checksums against the current file contents.
 * A mismatch means the migration was modified after it was applied.
 */
export const schemaVersions = pgTable(
  "schema_versions",
  {
    version: text("version").primaryKey(),
    checksum: text("checksum").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    appliedBy: text("applied_by"),
  },
  (t) => ({
    schemaVersionsAppliedAtIdx: index("schema_versions_applied_at_idx").on(
      t.appliedAt,
    ),
  }),
);

export type SchemaVersion = typeof schemaVersions.$inferSelect;
export type NewSchemaVersion = typeof schemaVersions.$inferInsert;

// ---------------------------------------------------------------------------
// Quota Requests (user self-service quota increases)
// ---------------------------------------------------------------------------

/**
 * quota_requests — user-submitted requests to increase their rate limits.
 *
 * Each row represents a single request from a user asking for a higher
 * cap on a specific quota dimension (e.g. prediction_limit).  Admins
 * review these and update status + review fields.
 *
 * `(user_id, status = 'pending')` is checked at creation time to enforce
 * a per-user cap on concurrent pending requests (see MAX_PENDING_REQUESTS
 * in the route layer).
 */
export const quotaRequests = pgTable(
  "quota_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    quotaType: text("quota_type").notNull(),
    requestedValue: integer("requested_value").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewNotes: text("review_notes"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    quotaRequestsUserIdIdx: index("quota_requests_user_id_idx").on(t.userId),
    quotaRequestsStatusIdx: index("quota_requests_status_idx").on(t.status),
  }),
);

export type QuotaRequest = typeof quotaRequests.$inferSelect;
export type NewQuotaRequest = typeof quotaRequests.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// ---------------------------------------------------------------------------
// Scheduled Reports
// ---------------------------------------------------------------------------
/**
 * scheduled_reports — user-configured recurring report exports.
 *
 * Each row represents a single scheduled report configuration owned by a user.
 * The scheduler runs these configurations according to their cron expressions.
 */
export const scheduledReports = pgTable(
  "scheduled_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reportType: text("report_type").notNull(),
    schedule: text("schedule").notNull(),
    format: text("format").notNull(),
    filters: jsonb("filters").default({}),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    scheduledReportsUserIdIdx: index("scheduled_reports_user_id_idx").on(t.userId),
    scheduledReportsActiveIdx: index("scheduled_reports_active_idx").on(t.active),
    scheduledReportsUserCreatedAtIdx: index("scheduled_reports_user_created_at_idx").on(
      t.userId,
      t.createdAt.desc(),
    ),
  }),
);

export type ScheduledReport = typeof scheduledReports.$inferSelect;
export type NewScheduledReport = typeof scheduledReports.$inferInsert;

// ---------------------------------------------------------------------------
// Market Watchers
// ---------------------------------------------------------------------------
/**
 * market_watchers — tracks users watching/subscribed to a market.
 */
export const marketWatchers = pgTable(
  "market_watchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    marketWatchersMarketIdIdx: index("market_watchers_market_id_idx").on(t.marketId),
    marketWatchersUserIdIdx: index("market_watchers_user_id_idx").on(t.userId),
    marketWatchersMarketUserIdx: index("market_watchers_market_user_idx").on(
      t.marketId,
      t.userId,
    ),
  }),
);

export type MarketWatcher = typeof marketWatchers.$inferSelect;
export type NewMarketWatcher = typeof marketWatchers.$inferInsert;

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------
/**
 * referrals — tracks referral codes created by users and their usage.
 *
 * Each row represents a referral code created by a user. When the code is
 * used by another user, `referredUser` is populated with their Stellar address.
 */
export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referralCode: text("referral_code").notNull().unique(),
    campaignId: text("campaign_id"),
    referredUser: text("referred_user"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    referralsUserIdIdx: index("referrals_user_id_idx").on(t.userId),
    referralsCodeIdx: index("referrals_code_idx").on(t.referralCode),
  }),
);

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;

