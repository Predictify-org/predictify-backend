import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { redis } from "../config/redis";
import { logger } from "../config/logger";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A single entry in the global leaderboard.
 * Aggregated across ALL markets (no time-window filter).
 */
export interface GlobalLeaderboardEntry extends Record<string, unknown> {
  /** UUID of the user row */
  user_id: string;
  /** Stellar public key of the user */
  stellar_address: string;
  /** Total number of predictions placed across every market */
  total_predictions: number;
  /** Number of predictions that matched the resolved outcome */
  correct_predictions: number;
  /**
   * Accuracy expressed as a percentage (0–100), rounded to 2 decimal places.
   * Zero for users with no predictions.
   */
  accuracy_percentage: number;
  /** Number of distinct markets in which the user has placed at least one prediction */
  total_markets: number;
  /**
   * Rank among all users, ordered by accuracy DESC then total_predictions DESC.
   * Computed server-side from the materialized view; 1-based.
   */
  rank: number;
}

/** Metadata attached to every paginated response. */
export interface GlobalLeaderboardMeta {
  limit: number;
  offset: number;
  count: number;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_KEY_PREFIX = "leaderboard:global";

/**
 * Cache key for a paginated global leaderboard slice.
 * Format: leaderboard:global:{limit}:{offset}
 */
function getPageCacheKey(limit: number, offset: number): string {
  return `${CACHE_KEY_PREFIX}:${limit}:${offset}`;
}

/**
 * Cache key for a single user's global entry.
 * Format: leaderboard:global:user:{stellarAddress}
 */
function getUserCacheKey(stellarAddress: string): string {
  return `${CACHE_KEY_PREFIX}:user:${stellarAddress}`;
}

/**
 * Delete all Redis keys for the global leaderboard namespace.
 * Called after a view refresh so stale pages and user lookups are evicted.
 */
async function invalidateGlobalCache(): Promise<void> {
  if (!redis) return;
  try {
    const pattern = `${CACHE_KEY_PREFIX}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug({ keysDeleted: keys.length }, "global leaderboard cache invalidated");
    }
  } catch (err) {
    // Cache invalidation failure is non-fatal; log and continue.
    logger.warn({ err }, "failed to invalidate global leaderboard cache");
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * The global leaderboard is backed by address_aggregates_mv, which already
 * aggregates every user across ALL resolved/disputed markets.  We extend it
 * on-the-fly with a correlated sub-query that counts distinct markets rather
 * than touching an additional large table.
 *
 * If the materialized view does not exist (CI / test environments without a DB)
 * the query will propagate the error to the caller.
 */
const SELECT_GLOBAL_LEADERBOARD_SQL = sql`
  SELECT
    aa.user_id,
    aa.stellar_address,
    aa.total_predictions,
    aa.correct_predictions,
    aa.accuracy_percentage,
    COALESCE(mp.market_count, 0)::integer AS total_markets,
    aa.rank
  FROM address_aggregates_mv aa
  LEFT JOIN (
    SELECT user_id, COUNT(DISTINCT market_id)::integer AS market_count
    FROM predictions
    GROUP BY user_id
  ) mp ON mp.user_id = aa.user_id
  ORDER BY aa.rank ASC
`;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Refresh the underlying address_aggregates_mv materialized view and
 * invalidate the global leaderboard cache so subsequent requests pick up
 * the updated data.
 *
 * The refresh uses CONCURRENTLY to avoid blocking concurrent reads.
 * This is an async operation; callers should await it before responding.
 */
export async function refreshGlobalLeaderboard(): Promise<void> {
  try {
    await db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY address_aggregates_mv`,
    );
    await invalidateGlobalCache();
    logger.info("global leaderboard materialized view refreshed");
  } catch (err) {
    logger.error({ err }, "failed to refresh global leaderboard materialized view");
    throw err;
  }
}

/**
 * Return a paginated slice of the global leaderboard.
 *
 * Results are served from the Redis cache when available (TTL = 5 min).
 * On cache miss the address_aggregates_mv view is queried directly.
 *
 * @param limit  - Maximum rows to return (1–100, default 50).
 * @param offset - Zero-based row offset for pagination (default 0).
 * @returns      - Array of GlobalLeaderboardEntry sorted by rank ASC.
 */
export async function getGlobalLeaderboard(
  limit: number = 50,
  offset: number = 0,
): Promise<GlobalLeaderboardEntry[]> {
  const cacheKey = getPageCacheKey(limit, offset);
  const correlationId = cacheKey; // included in structured logs

  // ── 1. Cache read ──────────────────────────────────────────────────────────
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug({ cacheKey }, "global leaderboard cache hit");
        return JSON.parse(cached) as GlobalLeaderboardEntry[];
      }
    } catch (err) {
      logger.warn(
        { err, cacheKey, correlationId },
        "global leaderboard cache read failed; falling back to DB",
      );
    }
  }

  // ── 2. DB query ────────────────────────────────────────────────────────────
  logger.debug({ cacheKey, limit, offset, correlationId }, "global leaderboard DB query");

  const result = await db.execute<GlobalLeaderboardEntry>(
    sql`${SELECT_GLOBAL_LEADERBOARD_SQL} LIMIT ${limit} OFFSET ${offset}`,
  );
  const rows = result.rows;

  // ── 3. Cache write (skip on empty results to avoid caching transient gaps) ─
  if (redis && rows.length > 0) {
    try {
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(rows));
    } catch (err) {
      logger.warn(
        { err, cacheKey, correlationId },
        "global leaderboard cache write failed; query still succeeded",
      );
    }
  }

  return rows;
}

/**
 * Return a single user's global leaderboard entry, or null if the address
 * has never placed a prediction.
 *
 * Cached separately from paginated slices (TTL = 5 min, including nulls so
 * negative lookups don't hammer the DB on repeat 404 requests).
 *
 * @param stellarAddress - The user's Stellar public key.
 * @returns              - Entry or null when not found.
 */
export async function getGlobalLeaderboardEntry(
  stellarAddress: string,
): Promise<GlobalLeaderboardEntry | null> {
  const cacheKey = getUserCacheKey(stellarAddress);
  const correlationId = cacheKey;

  // ── 1. Cache read ──────────────────────────────────────────────────────────
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        logger.debug({ cacheKey }, "global leaderboard user cache hit");
        return JSON.parse(cached) as GlobalLeaderboardEntry | null;
      }
    } catch (err) {
      logger.warn(
        { err, cacheKey, correlationId },
        "global leaderboard user cache read failed; falling back to DB",
      );
    }
  }

  // ── 2. DB query ────────────────────────────────────────────────────────────
  const result = await db.execute<GlobalLeaderboardEntry>(
    sql`
      SELECT
        aa.user_id,
        aa.stellar_address,
        aa.total_predictions,
        aa.correct_predictions,
        aa.accuracy_percentage,
        COALESCE(mp.market_count, 0)::integer AS total_markets,
        aa.rank
      FROM address_aggregates_mv aa
      LEFT JOIN (
        SELECT user_id, COUNT(DISTINCT market_id)::integer AS market_count
        FROM predictions
        GROUP BY user_id
      ) mp ON mp.user_id = aa.user_id
      WHERE aa.stellar_address = ${stellarAddress}
      LIMIT 1
    `,
  );
  const entry = result.rows[0] ?? null;

  // ── 3. Cache write (cache null to short-circuit repeated 404 lookups) ──────
  if (redis) {
    try {
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(entry));
    } catch (err) {
      logger.warn(
        { err, cacheKey, correlationId },
        "global leaderboard user cache write failed; query still succeeded",
      );
    }
  }

  return entry;
}

/**
 * Refresh the underlying materialized view, then return fresh paginated results.
 * Useful for the `refresh=true` query flag so clients can force an update
 * without calling a separate admin endpoint.
 *
 * @param limit  - Maximum rows to return.
 * @param offset - Zero-based row offset.
 * @returns      - Fresh GlobalLeaderboardEntry array.
 */
export async function getGlobalLeaderboardWithRefresh(
  limit: number = 50,
  offset: number = 0,
): Promise<GlobalLeaderboardEntry[]> {
  await refreshGlobalLeaderboard();
  return getGlobalLeaderboard(limit, offset);
}
