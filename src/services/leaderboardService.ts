import { db } from "../db";
import { sql } from "drizzle-orm";

export const leaderboardPeriods = ["daily", "weekly", "monthly"] as const;
export type LeaderboardPeriod = (typeof leaderboardPeriods)[number];

const leaderboardViews: Record<LeaderboardPeriod, string> = {
  daily: "leaderboard_daily_mv",
  weekly: "leaderboard_weekly_mv",
  monthly: "leaderboard_monthly_mv",
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { expiresAt: number; rows: LeaderboardEntry[] }>();

export interface LeaderboardEntry {
  [key: string]: unknown;
  user_id: string;
  stellar_address: string;
  total_predictions: number;
  correct_predictions: number;
  accuracy_percentage: number;
  rank: number;
}

function viewForPeriod(period: LeaderboardPeriod) {
  return sql.identifier(leaderboardViews[period]);
}

function cacheKey(period: LeaderboardPeriod, limit: number, offset: number): string {
  return `${period}:${limit}:${offset}`;
}

function clearPeriodCache(period: LeaderboardPeriod): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${period}:`)) {
      cache.delete(key);
    }
  }
}

export function clearLeaderboardCacheForTests(): void {
  cache.clear();
}

/**
 * Refresh the leaderboard materialized view
 * This should be called periodically (e.g., via cron or after market resolutions)
 */
export async function refreshLeaderboard(period: LeaderboardPeriod = "daily"): Promise<void> {
  await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewForPeriod(period)}`);
  clearPeriodCache(period);
}

/**
 * Get the leaderboard with optional limit and offset
 * @param period - Ranking window to read
 * @param limit - Maximum number of entries to return (default: 50)
 * @param offset - Number of entries to skip (default: 0)
 */
export async function getLeaderboard(
  period: LeaderboardPeriod = "daily",
  limit: number = 50,
  offset: number = 0
): Promise<LeaderboardEntry[]> {
  const key = cacheKey(period, limit, offset);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  const result = await db.execute<LeaderboardEntry>(
    sql`
      SELECT user_id, stellar_address, total_predictions, correct_predictions, 
             accuracy_percentage, rank
      FROM ${viewForPeriod(period)}
      ORDER BY rank ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `
  );
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, rows: result.rows });
  return result.rows;
}

/**
 * Get a specific user's leaderboard entry by stellar address
 * @param stellarAddress - The user's Stellar address
 * @param period - Ranking window to read
 */
export async function getUserLeaderboardEntry(
  stellarAddress: string,
  period: LeaderboardPeriod = "daily"
): Promise<LeaderboardEntry | null> {
  const result = await db.execute<LeaderboardEntry>(
    sql`
      SELECT user_id, stellar_address, total_predictions, correct_predictions, 
             accuracy_percentage, rank
      FROM ${viewForPeriod(period)}
      WHERE stellar_address = ${stellarAddress}
      LIMIT 1
    `
  );
  return result.rows[0] || null;
}

/**
 * Get leaderboard with automatic refresh
 * This refreshes the materialized view before returning data
 * Use this when you need the most up-to-date data
 */
export async function getLeaderboardWithRefresh(
  period: LeaderboardPeriod = "daily",
  limit: number = 50,
  offset: number = 0
): Promise<LeaderboardEntry[]> {
  await refreshLeaderboard(period);
  return getLeaderboard(period, limit, offset);
}
