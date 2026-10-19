import { env } from "../config/env";
import { logger } from "../config/logger";
import { pool } from "../db/client";
import {
  MarketWatcherLeaseSweeper,
  createRedisSweeperLock,
} from "../jobs/marketWatcherLeaseSweeper";
import { DrizzleMarketWatcherJobRepo } from "../services/marketWatcherJobService";
import { marketWatcherQueue, redisConnection } from "../queue";
import { MarketWatcherWorker } from "./marketWatcherWorker";

export interface MarketWatcherProcess {
  shutdown(): Promise<void>;
}

/**
 * Starts the market-watcher worker and the lease sweeper. `shutdown()` stops the
 * sweeper, then closes the BullMQ worker (which waits for in-flight jobs).
 */
export function startMarketWatcher(
  worker: Pick<MarketWatcherWorker, "start" | "stop">,
  sweeper: Pick<MarketWatcherLeaseSweeper, "start" | "stop">,
  cleanup: () => Promise<void> = async () => undefined,
): MarketWatcherProcess {
  worker.start();
  sweeper.start();
  let shutdownPromise: Promise<void> | null = null;
  return {
    shutdown() {
      shutdownPromise ??= (async () => {
        await sweeper.stop();
        await worker.stop();
        await cleanup();
      })();
      return shutdownPromise;
    },
  };
}

async function main(): Promise<void> {
  const repo = new DrizzleMarketWatcherJobRepo();
  const worker = new MarketWatcherWorker(repo);
  const sweeper = new MarketWatcherLeaseSweeper(repo, {
    queue: marketWatcherQueue,
    lock: createRedisSweeperLock(redisConnection),
    intervalMs: env.MARKET_WATCHER_SWEEP_INTERVAL_MS,
  });

  const proc = startMarketWatcher(worker, sweeper, async () => {
    await marketWatcherQueue.close();
    await pool.end();
    redisConnection.disconnect();
  });
  logger.info({ sweepIntervalMs: env.MARKET_WATCHER_SWEEP_INTERVAL_MS }, "market watcher process started");

  await new Promise<void>((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      logger.info({ signal }, "market watcher shutdown requested; draining");
      void proc.shutdown().finally(resolve);
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
  logger.info({}, "market watcher process stopped");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "market watcher process crashed");
      process.exit(1);
    });
}
