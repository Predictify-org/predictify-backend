import { db } from "../db";
import { sql } from "drizzle-orm";

export interface TrendingMarket extends Record<string, unknown> {
  id: string;
  question: string;
  status: string;
  resolution_time: Date;
  winning_outcome: string | null;
  metadata: unknown;
  total_predictions: number;
  total_volume: number;
}

/**
 * Refresh the trending markets materialized view.
 * Provided for external scheduling (e.g., pg_cron, Kubernetes CronJob).
 */
export async function refreshTrending(): Promise<void> {
  await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY market_trends_mv`);
}

/**
 * Get trending markets ordered by prediction count and volume.
 * @param limit - Maximum number of entries to return (default: 20, max: 100)
 * @param offset - Number of entries to skip (default: 0)
 */
export async function getTrending(
  limit: number = 20,
  offset: number = 0
): Promise<TrendingMarket[]> {
  const result = await db.execute<TrendingMarket>(
    sql`SELECT id, question, status, resolution_time, winning_outcome, metadata,
               total_predictions, total_volume
        FROM market_trends_mv
        ORDER BY total_predictions DESC, total_volume DESC
        LIMIT ${limit} OFFSET ${offset}`
  );
  return result.rows;
}
