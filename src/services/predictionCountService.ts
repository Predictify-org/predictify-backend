/**
 * predictionCountService.ts
 *
 * Returns the total number of predictions placed on a given market.
 * Results are cached in Redis (TTL: 60 s) so repeated reads do not hit
 * the database on every request.
 *
 * Cache key: markets:{marketId}:prediction-count
 *
 * Cache misses fall back to a COUNT(*) query; Redis errors are swallowed
 * so the endpoint remains functional even when Redis is unavailable.
 */

import { eq, count } from "drizzle-orm";
import { db } from "../db";
import { predictions, markets } from "../db/schema";
import { NotFoundError } from "../errors";
import { redisConnection } from "../queue";
import { marketCacheKeys } from "../cache/marketsCache";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

/** TTL for the prediction-count cache entry (seconds). */
const CACHE_TTL_SECONDS = 60;

export interface PredictionCountResult {
  marketId: string;
  count: number;
  /** ISO-8601 timestamp indicating when this count was last computed. */
  computedAt: string;
  /** true when the value came from the cache rather than a fresh DB query. */
  cached: boolean;
}

/**
 * Returns the total prediction count for `marketId`.
 *
 * 1. Validates the market exists (throws NotFoundError on miss).
 * 2. Checks Redis for a cached value; returns it immediately on hit.
 * 3. On cache miss, runs COUNT(*) from the predictions table, stores the
 *    result in Redis, and returns it.
 *
 * @param marketId - The market primary key (text / string)
 * @throws NotFoundError when the market does not exist
 */
export async function getPredictionCount(
  marketId: string,
): Promise<PredictionCountResult> {
  const reqId = getRequestId();

  // ── 1. Validate market exists ──────────────────────────────────────────
  const [market] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);

  if (!market) {
    logger.warn({ reqId, marketId }, "prediction_count_market_not_found");
    throw new NotFoundError(`Market ${marketId} not found`);
  }

  const cacheKey = marketCacheKeys.predictionCount(marketId);

  // ── 2. Cache read ──────────────────────────────────────────────────────
  try {
    const cached = await redisConnection.get(cacheKey);
    if (cached !== null) {
      const value = Number(cached);
      if (Number.isInteger(value) && value >= 0) {
        logger.debug(
          { reqId, marketId, count: value, cacheKey },
          "prediction_count_cache_hit",
        );
        return {
          marketId,
          count: value,
          computedAt: new Date().toISOString(),
          cached: true,
        };
      }
    }
  } catch (cacheErr) {
    // Redis unavailable — fall through to DB
    logger.warn(
      { reqId, marketId, err: cacheErr },
      "prediction_count_cache_read_failed",
    );
  }

  // ── 3. DB count ────────────────────────────────────────────────────────
  const [row] = await db
    .select({ value: count() })
    .from(predictions)
    .where(eq(predictions.marketId, marketId));

  const total = row?.value ?? 0;
  const computedAt = new Date().toISOString();

  logger.info(
    { reqId, marketId, count: total },
    "prediction_count_computed",
  );

  // ── 4. Cache write (best-effort) ────────────────────────────────────────
  try {
    await redisConnection.set(cacheKey, String(total), "EX", CACHE_TTL_SECONDS);
  } catch (cacheErr) {
    logger.warn(
      { reqId, marketId, err: cacheErr },
      "prediction_count_cache_write_failed",
    );
  }

  return { marketId, count: total, computedAt, cached: false };
}
