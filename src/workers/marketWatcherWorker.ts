import { Job, Worker } from "bullmq";
import { logger } from "../config/logger";
import {
  DrizzleMarketWatcherJobRepo,
  type MarketWatcherNotificationHandler,
  type MarketWatcherJobData,
  MarketWatcherJobCoordinator,
  type MarketWatcherJobRepo,
  defaultMarketWatcherHandler,
} from "../services/marketWatcherJobService";
import { redisConnection, marketWatcherQueueName } from "../queue";

export interface MarketWatcherWorkerOptions {
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  queue?: {
    add(
      name: string,
      data: MarketWatcherJobData,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
}

/**
 * BullMQ worker adapter for processing market watcher notification jobs.
 * Translates queue events to coordinator process calls.
 */
export class MarketWatcherWorker {
  private worker: Worker | null = null;
  private readonly coordinator: MarketWatcherJobCoordinator;
  private readonly handler: MarketWatcherNotificationHandler;
  private readonly concurrency: number;

  constructor(
    repository: MarketWatcherJobRepo = new DrizzleMarketWatcherJobRepo(),
    handler: MarketWatcherNotificationHandler = defaultMarketWatcherHandler,
    options: MarketWatcherWorkerOptions = {},
  ) {
    this.coordinator = new MarketWatcherJobCoordinator(repository, options);
    this.handler = handler;
    this.concurrency = options.concurrency ?? 4;
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<MarketWatcherJobData>(
      marketWatcherQueueName,
      async (job: Job<MarketWatcherJobData>) =>
        this.coordinator.process(job.data, this.handler),
      { connection: redisConnection, concurrency: this.concurrency },
    );
    this.worker.on("failed", (job, error) => {
      logger.error(
        { jobId: job?.id, marketId: job?.data.marketId, err: error.message },
        "market watcher queue job failed",
      );
    });
    logger.info({ concurrency: this.concurrency }, "market watcher worker started");
  }

  async stop(): Promise<void> {
    if (!this.worker) return;
    await this.worker.close();
    this.worker = null;
    logger.info("market watcher worker stopped");
  }
}

export function createMarketWatcherWorker(
  repository?: MarketWatcherJobRepo,
  handler?: MarketWatcherNotificationHandler,
  options?: MarketWatcherWorkerOptions,
): MarketWatcherWorker {
  return new MarketWatcherWorker(repository, handler, options);
}
