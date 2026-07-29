import { redisConnection } from "../queue";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

export const marketCacheKeys = {
  all: "markets:all",
  byId: (marketId: string) => `markets:${marketId}`,
};

export async function invalidateMarketCache(marketId: string): Promise<void> {
  const requestId = getRequestId();
  const keys = [marketCacheKeys.byId(marketId), marketCacheKeys.all];

  const results = await Promise.allSettled(keys.map((key) => redisConnection.del(key)));
  const failed = results.filter((result) => result.status === "rejected");

  if (failed.length > 0) {
    logger.error(
      { requestId, marketId, keys, errors: failed.map((result) => (result as PromiseRejectedResult).reason) },
      "Failed to invalidate market cache",
    );
    return;
  }

  logger.info({ requestId, marketId, keys }, "Market cache invalidated");
}
