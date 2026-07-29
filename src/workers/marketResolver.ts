import { Worker, Job } from "bullmq";
import {
  resolveMarket,
  DrizzleMarketResolutionRepo,
  type MarketResolvedEvent,
  type MarketResolutionRepo,
  type WebhookEmitter,
} from "../services/marketResolutionService";
import { db } from "../db";
import { logger } from "../config/logger";
import {
  redisConnection,
  marketResolutionQueue,
  marketResolutionQueueName,
} from "../queue";

export type { MarketResolvedEvent };

export class MarketResolverWorker {
  private readonly repo: MarketResolutionRepo;
  private readonly emitWebhook: WebhookEmitter | undefined;
  private worker: Worker | null = null;
  private readonly concurrency: number;

  constructor(
    repo: MarketResolutionRepo = new DrizzleMarketResolutionRepo(db),
    emitWebhook?: WebhookEmitter,
    concurrency = 5,
  ) {
    this.repo = repo;
    this.emitWebhook = emitWebhook;
    this.concurrency = concurrency;
  }

  async handleEvent(event: MarketResolvedEvent): Promise<void> {
    logger.info(
      { marketId: event.marketId, ledger: event.ledger },
      "market_resolver: queuing event",
    );
    await marketResolutionQueue.add("resolve", event);
  }

  start(): void {
    if (this.worker) return;

    logger.info(
      { concurrency: this.concurrency },
      "market_resolver.worker.start",
    );

    this.worker = new Worker(
      marketResolutionQueueName,
      async (job: Job<MarketResolvedEvent>) => {
        const event = job.data;
        logger.info(
          { marketId: event.marketId, ledger: event.ledger, jobId: job.id },
          "market_resolver: processing job",
        );

        const { processed } = await resolveMarket(
          this.repo,
          event,
          this.emitWebhook,
        );

        if (processed) {
          logger.info(
            { marketId: event.marketId, winningOutcome: event.winningOutcome },
            "market_resolver: market resolved successfully",
          );
        }
      },
      {
        // IORedis types conflict with BullMQ
        connection: redisConnection,
        concurrency: this.concurrency,
      },
    );

    this.worker.on("failed", (job, err) => {
      logger.error(
        { marketId: job?.data.marketId, jobId: job?.id, err: err.message },
        "market_resolver.worker.job_failed",
      );
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    logger.info("market_resolver.worker.stop");
  }
}

/** Singleton for use by the indexer polling loop. */
export const marketResolverWorker = new MarketResolverWorker();
