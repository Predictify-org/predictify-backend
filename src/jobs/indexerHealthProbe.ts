/**
 * indexerHealthProbe.ts
 *
 * Periodic job that checks indexer lag every minute and emits a structured
 * alert log when the lag exceeds INDEXER_LAG_ALERT_THRESHOLD ledgers.
 *
 * Lag = chain tip (latest ledger on Soroban RPC) − last indexed ledger
 * (cursor stored in indexer_cursor table).
 *
 * The current lag is also reflected as the Prometheus gauge
 * `indexer_lag_ledgers` so alerting rules can be defined in Prometheus / Grafana.
 *
 * Usage:
 *   import { startIndexerHealthProbe, stopIndexerHealthProbe } from "./jobs/indexerHealthProbe";
 *   const handle = startIndexerHealthProbe();
 *   // …at shutdown:
 *   stopIndexerHealthProbe(handle);
 */

import { env } from "../config/env";
import { logger } from "../config/logger";
import { IndexerService } from "../services/indexerService";
import { indexerLagLedgers } from "../metrics/registry";

/** How often the probe fires (ms). */
const PROBE_INTERVAL_MS = 60_000; // 1 minute

/**
 * Run a single lag-check probe cycle.
 *
 * Exported for unit testing so tests can call it directly without timers.
 *
 * @param service - IndexerService instance (injectable for tests)
 * @param threshold - Alert threshold in ledgers (injectable for tests)
 */
export async function runIndexerHealthProbe(
  service: Pick<IndexerService, "getCursor" | "getChainTip">,
  threshold: number = env.INDEXER_LAG_ALERT_THRESHOLD,
): Promise<void> {
  let cursor: number;
  let tip: number;

  try {
    [cursor, tip] = await Promise.all([service.getCursor(), service.getChainTip()]);
  } catch (err) {
    logger.error({ err }, "indexer_health_probe_fetch_failed");
    return;
  }

  const lag = Math.max(0, tip - cursor);

  // Update Prometheus gauge so dashboards / alertmanager can consume it.
  indexerLagLedgers.set(lag);

  if (lag > threshold) {
    logger.warn(
      {
        event: "indexer.lag_threshold_breached",
        lag,
        cursor,
        chainTip: tip,
        threshold,
      },
      "indexer lag exceeds threshold — investigate backfill or RPC connectivity",
    );
  } else {
    logger.debug(
      { event: "indexer.lag_ok", lag, cursor, chainTip: tip, threshold },
      "indexer lag within threshold",
    );
  }
}

/**
 * Start the periodic indexer health probe.
 *
 * Fires once immediately on startup, then every PROBE_INTERVAL_MS (60 s).
 * Returns the interval handle so the caller can stop it on graceful shutdown.
 *
 * @param service - Optional IndexerService override (useful for tests)
 * @returns NodeJS.Timeout handle
 */
export function startIndexerHealthProbe(
  service: Pick<IndexerService, "getCursor" | "getChainTip"> = new IndexerService(),
): NodeJS.Timeout {
  // Fire immediately, then on each interval tick.
  runIndexerHealthProbe(service).catch((err) =>
    logger.error({ err }, "indexer_health_probe_error"),
  );

  const handle = setInterval(() => {
    runIndexerHealthProbe(service).catch((err) =>
      logger.error({ err }, "indexer_health_probe_error"),
    );
  }, PROBE_INTERVAL_MS);

  logger.info(
    { intervalMs: PROBE_INTERVAL_MS, threshold: env.INDEXER_LAG_ALERT_THRESHOLD },
    "indexer health probe started",
  );

  return handle;
}

/**
 * Stop the periodic indexer health probe.
 *
 * @param handle - The handle returned by startIndexerHealthProbe
 */
export function stopIndexerHealthProbe(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  logger.info({}, "indexer health probe stopped");
}
