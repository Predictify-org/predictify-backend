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

  constructor(repo: FraudRepo = new DrizzleFraudRepo()) {
    this.repo = repo;
  }

  /** Run a single scan. Errors are caught and logged — the worker never throws. */
  async runOnce(opts: RunScanOptions = {}): Promise<RunScanResult | null> {
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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("fraud_detector: stopped");
    }
  }
}

/** Singleton for production wiring. */
export const fraudDetectorWorker = new FraudDetectorWorker();

// Allow `node dist/workers/fraudDetector.js` for ad-hoc runs.
if (require.main === module) {
  fraudDetectorWorker
    .runOnce()
    .then((res) => {
       
      console.log("fraud_scan", res);
      process.exit(0);
    })
    .catch((err) => {
       
      console.error(err);
      process.exit(1);
    });
}
