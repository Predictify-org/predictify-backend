import { logger } from "../config/logger";
import { refreshAddressAggregates } from "../services/addressAggregatesService";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Start an hourly worker that refreshes the address_aggregates_mv materialized view.
 * Uses REFRESH MATERIALIZED VIEW CONCURRENTLY so reads are never blocked.
 *
 * Returns the interval handle so callers can cancel it during shutdown.
 */
export function startRefreshAggregatesWorker(
  intervalMs: number = DEFAULT_INTERVAL_MS
): NodeJS.Timeout {
  const id = setInterval(async () => {
    const start = Date.now();
    try {
      await refreshAddressAggregates();
      logger.info(
        { durationMs: Date.now() - start },
        "address_aggregates_mv refreshed"
      );
    } catch (err) {
      logger.error({ err, durationMs: Date.now() - start }, "address_aggregates_mv refresh failed");
    }
  }, intervalMs);

  // Allow the timer to be garbage-collected even if the process would otherwise keep waiting
  id.unref();

  logger.info({ intervalMs }, "address_aggregates refresh worker started");
  return id;
}
