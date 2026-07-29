import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { redis } from "../config/redis";
import { LeaderboardPeriod } from "../routes/leaderboard";
import { logger } from "../config/logger";
import { AddressAggregate } from "./addressAggregatesService";

export type LeaderboardEntry = AddressAggregate;

/**
 * Build the materialized view name based on period
 * Follows naming convention: leaderboard_mv, leaderboard_monthly_mv, leaderboard_weekly_mv
 */
function getMaterializationViewName(period: LeaderboardPeriod): string {
  const _exhaustive = period;
  switch (period) {
    case LeaderboardPeriod.ALL_TIME: {
      return "leaderboard_mv";
    }
    case LeaderboardPeriod.MONTHLY: {
      return "leaderboard_monthly_mv";
    }
    case LeaderboardPeriod.WEEKLY: {
      return "leaderboard_weekly_mv";
    }
    default:
      throw new Error(`Unknown period: ${_exhaustive}`);
  }
}

/**
 * Build cache key for leaderboard queries
 * Format: leaderboard:{period}:{limit}:{offset}
 */
function getCacheKey(
  period: LeaderboardPeriod,
  limit: number,
  offset: number,
): string {
  return `leaderboard:${period}:${limit}:${offset}`;
}

/**
 * Build cache key for user leaderboard entries
 * Format: leaderboard:user:{stellarAddress}:{period}
 */
function getUserCacheKey(
  stellarAddress: string,
  period: LeaderboardPeriod,
): string {
  return `leaderboard:user:${stellarAddress}:${period}`;
}

/**
 * Refresh the leaderboard materialized view for a specific period
 * @param period - The leaderboard period to refresh
 */
export async function refreshLeaderboard(
  period: LeaderboardPeriod = LeaderboardPeriod.ALL_TIME,
): Promise<void> {
  const viewName = getMaterializationViewName(period);
  try {
    await db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ${sql.identifier(viewName)}`,
    );

    // Invalidate all caches for this period after refresh
    await invalidatePeriodCache(period);
    logger.info(
      { period, viewName },
      "Refreshed leaderboard materialized view",
    );
  } catch (err) {
    logger.error(
      { err, period, viewName },
      "Failed to refresh leaderboard materialized view",
    );
    throw err;
  }
}

/**
 * Invalidate all cached entries for a specific period
 * Uses Redis pattern scanning to clear all keys for the period
 */
async function invalidatePeriodCache(period: LeaderboardPeriod): Promise<void> {
  if (!redis) return;

  try {
    const pattern = `leaderboard:${period}:*`;
    const keys = await redis.keys(pattern);

    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug(
        { period, keysDeleted: keys.length },
        "Invalidated leaderboard cache",
      );
    }
  } catch (err) {
    logger.warn({ err, period }, "Failed to invalidate leaderboard cache");
    // Don't throw - cache invalidation failure shouldn't break the API
  }
}

/**
 * Get the leaderboard with optional limit and offset
 * Results are cached per period for 5 minutes
 * @param limit - Maximum number of entries to return (default: 50)
 * @param offset - Number of entries to skip (default: 0)
 * @param period - Leaderboard period: "all-time", "monthly", or "weekly"
 */
export async function getLeaderboard(
  limit: number = 50,
  offset: number = 0,
  period: LeaderboardPeriod = LeaderboardPeriod.ALL_TIME,
): Promise<LeaderboardEntry[]> {
  const cacheKey = getCacheKey(period, limit, offset);

  // Try to get from cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug({ cacheKey }, "Cache hit for leaderboard");
        return JSON.parse(cached) as LeaderboardEntry[];
      }
    } catch (err) {
      logger.warn(
        { err, cacheKey },
        "Cache read failed, proceeding with database query",
      );
    }
  }

  const viewName = getMaterializationViewName(period);
  const result = await db.execute<LeaderboardEntry>(
    sql`
      SELECT user_id, stellar_address, total_predictions, correct_predictions, 
             accuracy_percentage, rank
      FROM ${sql.identifier(viewName)}
      ORDER BY rank ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `,
  );

  const rows = result.rows;

  // Cache the results for 5 minutes (300 seconds)
  if (redis && rows.length > 0) {
    try {
      await redis.setex(cacheKey, 300, JSON.stringify(rows));
    } catch (err) {
      logger.warn({ err, cacheKey }, "Cache write failed, but query succeeded");
    }
  }

  return rows;
}

/**
 * Get a specific user's leaderboard entry by stellar address
 * Results are cached per period for 5 minutes
 * @param stellarAddress - The user's Stellar address
 * @param period - Leaderboard period: "all-time", "monthly", or "weekly"
 */
export async function getUserLeaderboardEntry(
  stellarAddress: string,
  period: LeaderboardPeriod = LeaderboardPeriod.ALL_TIME,
): Promise<LeaderboardEntry | null> {
  const cacheKey = getUserCacheKey(stellarAddress, period);

  // Try to get from cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug({ cacheKey }, "Cache hit for user leaderboard entry");
        return JSON.parse(cached) as LeaderboardEntry | null;
      }
    } catch (err) {
      logger.warn(
        { err, cacheKey },
        "Cache read failed, proceeding with database query",
      );
    }
  }

  const viewName = getMaterializationViewName(period);
  const result = await db.execute<LeaderboardEntry>(
    sql`
      SELECT user_id, stellar_address, total_predictions, correct_predictions, 
             accuracy_percentage, rank
      FROM ${sql.identifier(viewName)}
      WHERE stellar_address = ${stellarAddress}
      LIMIT 1
    `,
  );

  const entry = result.rows[0] || null;

  // Cache the result (even null) for 5 minutes
  if (redis) {
    try {
      await redis.setex(cacheKey, 300, JSON.stringify(entry));
    } catch (err) {
      logger.warn({ err, cacheKey }, "Cache write failed, but query succeeded");
    }
  }

  return entry;
}

/**
 * Get leaderboard with automatic refresh
 * This refreshes the materialized view before returning data
 * Use this when you need the most up-to-date data
 * @param limit - Maximum number of entries to return (default: 50)
 * @param offset - Number of entries to skip (default: 0)
 * @param period - Leaderboard period: "all-time", "monthly", or "weekly"
 */
export async function getLeaderboardWithRefresh(
  limit: number = 50,
  offset: number = 0,
  period: LeaderboardPeriod = LeaderboardPeriod.ALL_TIME,
): Promise<LeaderboardEntry[]> {
  await refreshLeaderboard(period);
  return getLeaderboard(limit, offset, period);
}
