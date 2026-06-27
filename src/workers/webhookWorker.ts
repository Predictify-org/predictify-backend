import { Worker, Job } from "bullmq";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { webhookDeliveries, webhookSubscriptions } from "../db/schema";
import { attemptDelivery, getOverdueDeliveries } from "../services/webhookDispatcher";
import { logger } from "../config/logger";
import { redisConnection, webhookQueueName, webhookQueue } from "../queue";

export { getOverdueDeliveries };

export interface WorkerOptions {
  /** Polling interval in milliseconds (default: 10 000). Ignored in BullMQ version. */
  intervalMs?: number;
  /** Maximum parallel deliveries per tick (default: 10). */
  concurrency?: number;
}

export class WebhookWorker {
  private readonly db: NodePgDatabase;
  private readonly concurrency: number;
  private worker: Worker | null = null;

  constructor(db: NodePgDatabase, opts: WorkerOptions = {}) {
    this.db = db;
    this.concurrency = opts.concurrency ?? 10;
  }

  /** Start the BullMQ worker. */
  start(): void {
    if (this.worker) return;

    logger.info({ concurrency: this.concurrency }, "webhook.worker.start");

    this.worker = new Worker(
      webhookQueueName,
      async (job: Job) => {
        const { deliveryId } = job.data;

        // Fetch the delivery from DB
        const [delivery] = await this.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId));

        if (!delivery) {
          logger.warn({ deliveryId }, "webhook.worker.delivery_not_found");
          return;
        }

        // If it was already completed or terminal, skip
        if (delivery.status === "success" || delivery.status === "terminal") {
          return;
        }

        const [sub] = await this.db
          .select()
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.id, delivery.subscriptionId));

        if (!sub) {
          logger.warn({ deliveryId }, "webhook.worker.subscription_not_found");
          await this.db
            .update(webhookDeliveries)
            .set({ status: "terminal", updatedAt: new Date() })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }

        const rawBody = Buffer.from(JSON.stringify(delivery.payload), "utf8");

        const result = await attemptDelivery(
          this.db,
          delivery.id,
          sub.url,
          sub.secret,
          rawBody,
          delivery.eventType,
        );

        if (!result.success) {
          // Check next state to schedule retry
          const [updated] = await this.db
            .select()
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.id, delivery.id));

          if (updated && updated.status === "failed") {
            const delay = Math.max(0, updated.nextRetryAt.getTime() - Date.now());
            await webhookQueue.add("deliver", { deliveryId: delivery.id }, { delay });
          }

          throw new Error(result.error || "Delivery failed");
        }
      },
      { 
        // @ts-expect-error IORedis types conflict with BullMQ
        connection: redisConnection, 
        concurrency: this.concurrency 
      }
    );

    this.worker.on("failed", (job, err) => {
      logger.error({ deliveryId: job?.data.deliveryId, err: err.message }, "webhook.worker.job_failed");
    });
  }

  /** Stop the BullMQ worker and wait for current jobs to finish. */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    logger.info("webhook.worker.stop");
  }
}
