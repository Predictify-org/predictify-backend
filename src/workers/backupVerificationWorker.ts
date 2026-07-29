import { Worker, Job } from "bullmq";
import {
  createDefaultBackupVerifier,
  BackupVerifier,
  BackupVerificationResult,
} from "./backupVerifier";
import { logger } from "../config/logger";
import { redisConnection, backupVerificationQueueName } from "../queue";

export class BackupVerificationWorker {
  private readonly verifierFactory: () => BackupVerifier;
  private worker: Worker | null = null;
  private readonly concurrency: number;

  constructor(
    verifierFactory: () => BackupVerifier = createDefaultBackupVerifier,
    concurrency = 1,
  ) {
    this.verifierFactory = verifierFactory;
    this.concurrency = concurrency;
  }

  start(): void {
    if (this.worker) return;

    logger.info(
      { concurrency: this.concurrency },
      "backup_verification.worker.start",
    );

    this.worker = new Worker(
      backupVerificationQueueName,
      async (job: Job) => {
        logger.info({ jobId: job.id }, "backup_verification: processing job");
        const verifier = this.verifierFactory();
        const result: BackupVerificationResult = await verifier.run();

        if (!result.success) {
          throw new Error(result.error || "Backup verification failed");
        }

        logger.info(
          { jobId: job.id, runId: result.runId },
          "backup_verification: completed successfully",
        );
        return result;
      },
      {
        // IORedis types conflict with BullMQ
        connection: redisConnection,
        concurrency: this.concurrency,
      },
    );

    this.worker.on("failed", (job, err) => {
      logger.error(
        { jobId: job?.id, err: err.message },
        "backup_verification.worker.job_failed",
      );
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    logger.info("backup_verification.worker.stop");
  }
}

export const backupVerificationWorker = new BackupVerificationWorker();
