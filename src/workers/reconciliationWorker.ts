import { v4 as uuidv4 } from "uuid";
import { Worker, Job } from "bullmq";
import {
  performReconciliation,
  reconcileMarket,
} from "../services/reconciliationService";
import { logger } from "../config/logger";
import { redisConnection, reconciliationQueueName } from "../queue";
import { reconciliationDiscrepanciesTotal } from "../metrics/registry";
import { createAuditLog } from "../services/auditService";

export interface ReconciliationJobPayload {
  type: "global" | "market";
  marketId?: string;
  adminAddress?: string;
  ip?: string;
  correlationId?: string;
}

export class ReconciliationWorker {
  private worker: Worker | null = null;
  private readonly concurrency: number;

  constructor(concurrency = 5) {
    this.concurrency = concurrency;
  }

  start(): void {
    if (this.worker) return;

    logger.info(
      { concurrency: this.concurrency },
      "reconciliation.worker.start",
    );

    this.worker = new Worker(
      reconciliationQueueName,
      async (job: Job<ReconciliationJobPayload>) => {
        const data = job.data;
        logger.info(
          { jobId: job.id, type: data.type },
          "reconciliation: processing job",
        );

        if (data.type === "global") {
          const result = await performReconciliation();
          logger.info(
            { jobId: job.id, status: result.status, discrepancyCount: result.discrepancyCount },
            "reconciliation: global reconciliation completed",
          );

          if (result.status === "discrepancies_found" && result.discrepancies?.length > 0) {
            for (const d of result.discrepancies) {
              reconciliationDiscrepanciesTotal.inc({ kind: d.kind });
            }
            await createAuditLog({
              action: "reconciliation.discrepancies_found",
              walletAddress: "system",
              ip: "127.0.0.1",
              correlationId: job.id ?? uuidv4(),
              metadata: {
                reportId: result.reportId,
                fingerprint: result.fingerprint,
                discrepancyCount: result.discrepancyCount,
                summary: result.summary,
              },
            });
          }

          return result;
        } else if (data.type === "market") {
          if (
            !data.marketId ||
            !data.adminAddress ||
            !data.ip ||
            !data.correlationId
          ) {
            throw new Error(
              "Missing required parameters for market reconciliation",
            );
          }
          const result = await reconcileMarket({
            marketId: data.marketId,
            adminAddress: data.adminAddress,
            ip: data.ip,
            correlationId: data.correlationId,
          });
          logger.info(
            { jobId: job.id, marketId: data.marketId, status: result.status },
            "reconciliation: market reconciliation completed",
          );
          return result;
        } else {
          throw new Error(`Unknown reconciliation job type: ${data.type}`);
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
        { jobId: job?.id, type: job?.data.type, err: err.message },
        "reconciliation.worker.job_failed",
      );
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    logger.info("reconciliation.worker.stop");
  }
}

export const reconciliationWorker = new ReconciliationWorker();
