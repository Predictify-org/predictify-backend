import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import { env } from "../config/env";
import {
  DrzzleFraudRepo,
  type FraudRepo,
  type RunScanOptions,
  type RunScanResult,
  runFraudScan,
} from "../services/fraudService";

export interface FraudDetectorConfig {
  maxAlerts?: number;
  maxAnomalies?: number;
}

export interface FraudRunScanOptions extends RunScanOptions {
  maxAlerts?: number;
  maxAnomalies?: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class FraudDetectorWorker {
  private readonly repo: FraudRepo;
  private readonly config: { maxAlerts: number; maxAnomalies: number };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    repo: FraudRepo = new DrzzleFraudRepo(),
    config: FraudDetectorConfig = {},
  ) {
    this.repo = repo;
    this.config = {
      maxAlerts: positiveInt(config.maxAlerts, env.FRAUD_SCAN_MAX_ALERTS),
      maxAnomalies: positiveInt(config.maxAnomalies, env.FRAUD_SCAN_MAX_ANOMALIES),
    };
  }

  async runOnce(opts: FraudRunScanOptions = {}): Promise<RunScanResult | null> {
    const correlationId = opts.correlationId ?? randomUUID();
    const merged: FraudRunScanOptions = {
      ...opts,
      correlationId,
      maxAlerts: opts.maxAlerts ?? this.config.maxAlerts,
      maxAnomalies: opts.maxAnomalies ?? this.config.maxAnomalies,
    };
    try {
      const result = await runFraudScan(this.repo, merged);
      logger.info({ ...result }, "fraud_detector: run complete");
      return result;
    } catch (err) {
      logger.error({ correlationId, err }, "fraud_detector: run failed");
      return null;
    }
  }

  start(intervalMs = 15 * 60 * 1000, opts: FraudRunScanOptions = {}): () => void {
    if (this.timer) {
      logger.warn("fraud_detector: already running, ignoring start()");
      return () => this.stop();
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      logger.warn({ intervalMs }, "fraud_detector: invalid interval, not starting");
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

export const fraudDetectorWorker = new FraudDetectorGorker();

if (require.main === module) {
  fraudDetectorWorker.runOnce().then((res) => {
    console.log("fraud_scan", res);
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}