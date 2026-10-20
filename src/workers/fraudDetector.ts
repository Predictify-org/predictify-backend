/**
 * fraudDetector.ts — background worker that periodically scans recent
 * predictions for sybil / collusion clusters and persists `fraud_flags`.
 *
 * Designed to be invoked from:
 *   • a cron-style scheduler (every N minutes)
 *   • the existing in-process scheduler (`src/services/scheduler.ts`)
 *   • or one-off CLI runs (`node dist/workers/fraudDetector.js`)
 *
 * The worker itself is intentionally tiny — all logic lives in
 * `fraudService.ts` so it can be unit-tested without spinning up a job
 * runtime. A correlation id is generated per run so every log line and
 * persisted flag can be traced.
 */

import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import { closeDb } from "../db/client";
import {
  DrizzleFraudRepo,
  type FraudRepo,
  type RunScanOptions,
  type RunScanResult,
  runFraudScan,
} from "../services/fraudService";

export class FraudDetectorWorker {
  private readonly repo: FraudRepo;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;

  constructor(repo: FraudRepo = new DrizzleFraudRepo()) {
    this.repo = repo;
  }

  /** Run a single scan. Errors are caught and logged — the worker never throws. */
  async runOnce(opts: RunScanOptions = {}): Promise<RunScanResult | null> {
    if (this.shuttingDown) return null;
    if (this.running) {
      logger.warn("fraud_detector: scan already in progress, skipping overlap");
      return null;
    }
    this.running = true;
    const correlationId = opts.correlationId ?? randomUUID();
    const merged: RunScanOptions = { ...opts };
    merged.correlationId = correlationId;
    try {
      const result = await runFraudScan(this.repo, merged);
      logger.info({ ...result }, "fraud_detector: run complete");
      return result;
    } catch (err) {
      logger.error(
        { correlationId, err },
        "fraud_detector: run failed",
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Start a recurring scan. Returns a stop handle.
   * `intervalMs` defaults to 15 minutes; non-positive disables scheduling.
   */
  start(intervalMs = 15 * 60 * 1000, opts: RunScanOptions = {}): () => void {
    if (this.timer) {
      logger.warn("fraud_detector: already running, ignoring start()");
      return () => this.stop();
    }
    if (this.shuttingDown) {
      return () => undefined;
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      logger.warn(
        { intervalMs },
        "fraud_detector: invalid interval, not starting",
      );
      return () => undefined;
    }

    // Kick off immediately, then on interval.
    void this.runOnce(opts);
    this.timer = setInterval(() => {
      void this.runOnce(opts);
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    logger.info({ intervalMs }, "fraud_detector: started");
    return () => this.stop();
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("fraud_detector: stopped");
    }
  }
}

/** Singleton for production wiring. */
export const fraudDetectorWorker = new FraudDetectorWorker();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdownWithTimeout(timeoutMs = 10_000): Promise<void> {
  const timeout = sleep(timeoutMs);
  const cleanup = (async () => {
    try {
      await closeDb();
    } catch (err) {
      logger.warn({ err }, "fraud_detector: failed to close db");
    }
  })();
  await Promise.race([cleanup, timeout]);
}

async function main(): Promise<void> {
  const worker = fraudDetectorWorker;
  const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let shutting = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shutting) return;
    shutting = true;
    logger.info({ signal }, "fraud_detector: shutdown requested");
    worker.stop();
    void shutdownWithTimeout()
      .finally(() => process.exit(0))
      .catch(() => process.exit(0));
  };

  for (const signal of stopSignals) {
    process.once(signal, shutdown);
  }

  const intervalMs = Number.parseInt(process.env.FRAUD_DETECTOR_INTERVAL_MS ?? "", 10);
  const opts: RunScanOptions = {};

  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    worker.start(intervalMs, opts);
    // Keep the process alive for the scheduler
    await new Promise<void>(() => undefined);
    return;
  }

  // One-off run (e.g. `node dist/workers/fraudDetector.js`)
  const res = await worker.runOnce(opts);
  console.log("fraud_scan", res);
  await shutdownWithTimeout(5000);
}

// Allow `node dist/workers/fraudDetector.js` for ad-hoc runs.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    void shutdownWithTimeout(2000).finally(() => process.exit(1));
  });
}
