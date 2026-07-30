import { z } from "zod";

const baseSchema = z.object({
  // ── Application ───────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  FLAGS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),

  // ── Database & Cache ──────────────────────────────────────
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // ── JWT ───────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("predictify"),
  JWT_AUDIENCE: z.string().default("predictify-app"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // See src/utils/keyRing.ts for the "kid:secret,..." format and rotation flow.
  JWT_KEYS: z.string().optional(),
  JWT_ACTIVE_KID: z.string().optional(),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(30),

  // ── Stellar / Soroban ─────────────────────────────────────
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  SOROBAN_RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),
  PREDICTIFY_CONTRACT_ID: z.string().min(1),

  // ── Indexer tunables ──────────────────────────────────────
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_REWIND_LEDGERS: z.coerce.number().int().nonnegative().default(100),
  INDEXER_BACKFILL_CHUNK_SIZE: z.coerce.number().int().positive().default(500),
  INDEXER_GAP_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  INDEXER_LAG_ALERT_THRESHOLD: z.coerce.number().int().positive().default(200),

  // ── Reconciliation ────────────────────────────────────────
  RECONCILIATION_ENABLED: z.coerce.boolean().default(false),
  RECONCILIATION_SCHEDULE: z.string().default("0 2 * * *"),

  // ── Administration ────────────────────────────────────────
  ADMIN_ALLOWLIST: z.string().default("").transform((val) => val.split(",").map((s) => s.trim()).filter(Boolean)),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // ── Webhook CORS ─────────────────────────────────────────
  WEBHOOK_CORS_ALLOWED_ORIGINS: z.string().default(""),

  // ── Markets CORS ─────────────────────────────────────────
  MARKETS_CORS_ALLOWED_ORIGINS: z.string().default(""),

  // ── Notifications CORS ──────────────────────────────────
  NOTIFICATIONS_CORS_ALLOWED_ORIGINS: z.string().default(""),

  // ── Stats CORS ──────────────────────────────────────────
  STATS_CORS_ALLOWED_ORIGINS: z.string().default(""),

  // ── Geo-blocking ──────────────────────────────────────────
  GEO_BLOCKED_COUNTRIES: z.string().default("").transform((val) =>
    val.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  ),
  MMDB_PATH: z.string().default(""),
  GEO_ALLOWLIST: z.string().default("").transform((val) =>
    val.split(",").map((s) => s.trim()).filter(Boolean),
  ),

  // ── Anonymous rate limiting ───────────────────────────────
  ANON_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ANON_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  TRUST_PROXY: z.coerce.boolean().default(false),

  // ── Login rate limiting (per-IP, sliding window) ─────────
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // ── Captcha gate (per-IP, unauthenticated endpoints) ─────
  /** Number of requests per IP per window before captcha is required (0 = disabled) */
  CAPTCHA_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
  /** Sliding window length for captcha threshold tracking (ms) */
  CAPTCHA_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // ── Webhooks rate limiting (per user) ─────────────────────
  WEBHOOKS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  WEBHOOKS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // ── Invites rate limiting (per user, token bucket) ────────
  INVITES_RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(60),
  INVITES_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // ── Exports rate limiting (per user, token bucket) ────────
  EXPORTS_RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(60),
  EXPORTS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // ── Settle confirmer ──────────────────────────────────────
  SETTLE_CONFIRMER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  SETTLE_CONFIRMER_CONFIRMATION_LEDGERS: z.coerce.number().int().positive().default(2),

  // ── Slow Query Alerter ────────────────────────────────────
  SLOW_QUERY_ALERTER_ENABLED: z.coerce.boolean().default(false),
  SLOW_QUERY_ALERTER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SLOW_QUERY_ALERTER_MEAN_EXEC_TIME_THRESHOLD_MS: z.coerce.number().int().positive().default(100),
  SLOW_QUERY_ALERTER_MAX_EXEC_TIME_THRESHOLD_MS: z.coerce.number().int().positive().default(500),
  SLOW_QUERY_ALERTER_LIMIT: z.coerce.number().int().positive().default(10),
  SLOW_QUERY_ALERTER_QUERY_MAX_LENGTH: z.coerce.number().int().positive().default(1000),

  // ── Predictions Confirmer ───────────────────────────────────
  PREDICTION_CONFIRM_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  PREDICTION_CONFIRM_BATCH_SIZE: z.coerce.number().int().positive().default(1000),
  PREDICTION_CONFIRM_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // ── Metrics ───────────────────────────────────────────────
  /** Bearer token required to access /api/metrics. Empty string (default) means no auth. */
  METRICS_AUTH_TOKEN: z.string().default(""),
  // ── CSRF (double-submit cookie) ───────────────────────────
  /** Name of the CSRF token cookie. Not httpOnly — the client must be able to read it. */
  CSRF_COOKIE_NAME: z.string().default("csrf_token"),
  /** Name of the header clients must echo the CSRF token back in. */
  CSRF_HEADER_NAME: z.string().default("x-csrf-token"),
  /** Lifetime of an issued CSRF token, in seconds. */
  CSRF_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7200),
  /** Name of the session/auth cookie whose presence triggers CSRF enforcement. */
  SESSION_COOKIE_NAME: z.string().default("session"),
});

export const envSchema = baseSchema.refine(
  (data) => data.JWT_TTL_SECONDS >= data.WORKER_HEARTBEAT_SECONDS * 2,
  (data) => ({
    message: `JWT_TTL_SECONDS (${data.JWT_TTL_SECONDS}) must be at least WORKER_HEARTBEAT_SECONDS * 2 (${data.WORKER_HEARTBEAT_SECONDS * 2})`,
    path: ["JWT_TTL_SECONDS"],
  })
);

export type Env = z.infer<typeof baseSchema>;

// Returns a bullet-list string of all validation failures, suitable for console output.
export function formatEnvErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

