/**
 * webhookWorker.ts
 *
 * Background polling worker that picks up pending/failed webhook deliveries
 * whose `nextRetryAt` timestamp has elapsed and drives them through
 * `attemptDelivery`.
 *
 * Usage
 * ─────
 *   import { WebhookWorker } from "./workers/webhookWorker";
 *
 *   const worker = new WebhookWorker(db, { intervalMs: 10_000, concurrency: 10 });
 *   worker.start();
 *   // ...later, on graceful shutdown:
 *   await worker.stop();
 *
 * The worker processes up to `concurrency` deliveries per tick with
 * Promise.allSettled so a slow subscriber never starves others.
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { webhookDeliveries, webhookSubscriptions } from "../db/schema";
import { attemptDelivery, getOverdueDeliveries } from "../services/webhookDispatcher";
import { logger } from "../config/logger";

// Re-export so external code can import from the worker module only.
export { getOverdueDeliveries };

export interface WorkerOptions {
  /** Polling interval in milliseconds (default: 10 000). */
  intervalMs?: number;
  /** Maximum parallel deliveries per tick (default: 10). */
  concurrency?: number;
}

export class WebhookWorker {
  private readonly db: NodePgDatabase;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Tracks the active processing tick so stop() can await it. */
  private tickPromise: Promise<void> = Promise.resolve();

  constructor(db: NodePgDatabase, opts: WorkerOptions = {}) {
    this.db = db;
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.concurrency = opts.concurrency ?? 10;
  }

  /** Start the polling loop. Safe to call multiple times (no-op if running). */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info({ intervalMs: this.intervalMs, concurrency: this.concurrency }, "webhook.worker.start");
    this.schedule();
  }

  /** Stop the polling loop and wait for the current tick to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.tickPromise;
    logger.info("webhook.worker.stop");
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tickPromise = this.tick().catch((err) => {
        logger.error({ err }, "webhook.worker.tick.error");
      });
      this.tickPromise.finally(() => this.schedule());
    }, this.intervalMs);
  }

  /**
   * One polling tick: fetch overdue deliveries, look up subscription secrets,
   * and attempt each delivery concurrently (capped at `concurrency`).
   */
  private async tick(): Promise<void> {
    const deliveries = await getOverdueDeliveries(this.db, this.concurrency);
    if (deliveries.length === 0) return;

    logger.debug({ count: deliveries.length }, "webhook.worker.tick");

    await Promise.allSettled(
      deliveries.map(async (delivery) => {
        // Look up the subscription to get the url and secret.
        const [sub] = await this.db
          .select()
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.id, delivery.subscriptionId));

        if (!sub) {
          logger.warn({ deliveryId: delivery.id }, "webhook.worker.subscription_not_found");
          // Mark as terminal so the worker doesn't keep retrying forever.
          await this.db
            .update(webhookDeliveries)
            .set({ status: "terminal", updatedAt: new Date() })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }

        const rawBody = Buffer.from(JSON.stringify(delivery.payload), "utf8");

        await attemptDelivery(
          this.db,
          delivery.id,
          sub.url,
          sub.secret,
          rawBody,
          delivery.eventType,
        );
      }),
    );
  }
}
