import { Job, Worker } from "bullmq";
import { logger } from "../config/logger";
import {
  DrizzleReportRunRepository,
  type ReportGenerator,
  type ReportRunJobData,
  ScheduledReportRunCoordinator,
  type ReportRunRepository,
} from "../services/scheduledReportJobService";
import { redisConnection, scheduledReportQueueName } from "../queue";

export interface ScheduledReportWorkerOptions {
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  queue?: { add(name: string, data: ReportRunJobData, options?: Record<string, unknown>): Promise<unknown> };
}

/**
 * BullMQ adapter for the durable run coordinator. The coordinator owns all
 * correctness decisions; this class only translates queue jobs into calls.
 */
export class ScheduledReportWorker {
  private worker: Worker | null = null;
  private readonly coordinator: ScheduledReportRunCoordinator;
  private readonly concurrency: number;

  constructor(
    repository: ReportRunRepository = new DrizzleReportRunRepository(),
    generator: ReportGenerator = async ({ scheduleKey }) => ({ outputRef: `pending://${scheduleKey}` }),
    options: ScheduledReportWorkerOptions = {},
  ) {
    this.coordinator = new ScheduledReportRunCoordinator(repository, options);
    this.generator = generator;
    this.concurrency = options.concurrency ?? 4;
  }

  private readonly generator: ReportGenerator;

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<ReportRunJobData>(
      scheduledReportQueueName,
      async (job: Job<ReportRunJobData>) => this.coordinator.process(job.data, this.generator),
      { connection: redisConnection, concurrency: this.concurrency },
    );
    this.worker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, runId: job?.data.runId, err: error.message }, "scheduled report queue job failed");
    });
    logger.info({ concurrency: this.concurrency }, "scheduled report worker started");
  }

  async stop(): Promise<void> {
    if (!this.worker) return;
    await this.worker.close();
    this.worker = null;
    logger.info("scheduled report worker stopped");
  }
}

export function createScheduledReportWorker(
  repository?: ReportRunRepository,
  generator?: ReportGenerator,
  options?: ScheduledReportWorkerOptions,
): ScheduledReportWorker {
  return new ScheduledReportWorker(repository, generator, options);
}
