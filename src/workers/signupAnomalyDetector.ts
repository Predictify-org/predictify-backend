/**
 * signupAnomalyDetector.ts — background worker that periodically scans the
 * signup rate for floods (bot registration waves, airdrop farming, sybil
 * onboarding).
 *
 * Designed to be invoked from:
 *   • a cron-style scheduler (every N minutes)
 *   • the existing in-process scheduler (`src/services/scheduler.ts`)
 *   • or one-off CLI runs (`node dist/workers/signupAnomalyDetector.js`)
 *
 * The worker is intentionally tiny — all logic lives in
 * `src/services/anomalyDetector.ts` so it can be unit-tested without a job
 * runtime. A correlation id is generated per run so every log line emitted by
 * the scan can be tied back to it.
 */

import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import {
  DrizzleSignupAnomalyRepo,
  type RunSignupAnomalyScanOptions,
  type SignupAnomalyRepo,
  type SignupAnomalyReport,
  runSignupAnomalyScan,
} from "../services/anomalyDetector";

/** Default cadence — matches the default 30-minute evaluation window. */
export const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class SignupAnomalyDetectorWorker {
  private readonly repo: SignupAnomalyRepo;
  private timer: NodeJS.Timeout | null = null;

  constructor(repo: SignupAnomalyRepo = new DrizzleSignupAnomalyRepo()) {
    this.repo = repo;
  }

  /** Run a single scan. Errors are caught and logged — the worker never throws. */
  async runOnce(
    opts: RunSignupAnomalyScanOptions = {},
  ): Promise<SignupAnomalyReport | null> {
    const correlationId = opts.correlationId ?? randomUUID();
    try {
      const report = await runSignupAnomalyScan(this.repo, {
        ...opts,
        correlationId,
      });
      logger.info(
        {
          correlationId,
          anomalies: report.anomalies.length,
          totalSignups: report.totalSignups,
          topScore: report.topScore,
        },
        "signup_anomaly_detector: run complete",
      );
      return report;
    } catch (err) {
      logger.error(
        { correlationId, err },
        "signup_anomaly_detector: run failed",
      );
      return null;
    }
  }

  /**
   * Start a recurring scan. Returns a stop handle.
   * Non-positive or non-finite intervals disable scheduling.
   */
  start(
    intervalMs = DEFAULT_SCAN_INTERVAL_MS,
    opts: RunSignupAnomalyScanOptions = {},
  ): () => void {
    if (this.timer) {
      logger.warn("signup_anomaly_detector: already running, ignoring start()");
      return () => this.stop();
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      logger.warn(
        { intervalMs },
        "signup_anomaly_detector: invalid interval, not starting",
      );
      return () => undefined;
    }

    // Kick off immediately, then on interval.
    void this.runOnce(opts);
    this.timer = setInterval(() => {
      void this.runOnce(opts);
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    logger.info({ intervalMs }, "signup_anomaly_detector: started");
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("signup_anomaly_detector: stopped");
    }
  }
}

/** Singleton for production wiring. */
export const signupAnomalyDetectorWorker = new SignupAnomalyDetectorWorker();

// Allow `node dist/workers/signupAnomalyDetector.js` for ad-hoc runs.
/* istanbul ignore next -- CLI entry point, never reached under Jest */
if (require.main === module) {
  signupAnomalyDetectorWorker
    .runOnce()
    .then((report) => {
      console.log("signup_anomaly_scan", JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
