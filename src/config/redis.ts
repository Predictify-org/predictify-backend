/**
 * @module config/redis
 *
 * Shared Redis client for optional caching operations (leaderboard, etc.).
 *
 * The client is optional — if REDIS_URL is not set or the connection fails
 * at boot, `redis` is exported as `null` and callers must guard accordingly.
 * This keeps the API server functional even in environments without Redis.
 */
import IORedis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

let redis: IORedis | null = null;

try {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  client.on("error", (err) => {
    logger.warn({ err }, "redis_cache_error");
  });

  redis = client;
} catch (err) {
  logger.warn({ err }, "redis_cache_unavailable");
}

export { redis };
