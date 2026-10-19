import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { logger } from "../config/logger";
import { marketWatcherJobsRecoveredTotal } from "../metrics/registry";
import {
  DEFAULT_MAX_ATTEMPTS,
  type MarketWatcherJobData,
  type MarketWatcherJobRepo,
} from "../services/marketWatcherJobService";
import type { MarketWatcherJob } from "../db/schema";

export const SWEEPER_LOCK_KEY = "market-watcher:sweeper:lock";
const LIVE_STATES = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

export interface SweeperLock {
  /** Returns true when this caller now holds the lock for ttlMs. */
  acquire(key: string, ttlMs: number): Promise<boolean>;
}

export interface SweeperQueue {
  add(
    name: string,
    data: MarketWatcherJobData,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  getJob(id: string): Promise<{ getState(): Promise<string> } | null | undefined>;
}

export interface MarketWatcherLeaseSweeperOptions {
  queue: SweeperQueue;
  lock: SweeperLock;
  intervalMs: number;
  maxAttempts?: number;
  batchLimit?: number;
  now?: () => Date;
}

export interface SweepResult {
  locked: boolean;
  recovered: number;
  enqueued: number;
}

/** Redis `SET key token NX PX ttl` lock so only one replica sweeps per interval. */
export function createRedisSweeperLock(redis: Pick<Redis, "set">): SweeperLock {
  return {
    async acquire(key, ttlMs) {
      const res = await redis.set(key, randomUUID(), "PX", ttlMs, "NX");
      return res === "OK";
    },
  };
}

/**
 * Recovers market-watcher jobs whose worker died: expired leases go back to
 * `retryable` (or `failed` when attempts are exhausted) and every due retryable
 * job without a live BullMQ job is re-enqueued under a fresh `:recover:` id.
 */
export class MarketWatcherLeaseSweeper {
  private readonly queue: SweeperQueue;
  private readonly lock: SweeperLock;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly batchLimit: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> = Promise.resolve();
  private running = false;

  constructor(
    private readonly repository: MarketWatcherJobRepo,
    options: MarketWatcherLeaseSweeperOptions,
  ) {
    this.queue = options.queue;
    this.lock = options.lock;
    this.intervalMs = options.intervalMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchLimit = options.batchLimit ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  async sweepOnce(): Promise<SweepResult> {
    const acquired = await this.lock.acquire(SWEEPER_LOCK_KEY, this.intervalMs);
    if (!acquired) {
      return { locked: false, recovered: 0, enqueued: 0 };
    }

    const now = this.now();
    const expired = await this.repository.recoverExpiredLeases(now, this.maxAttempts);
    const recoveredRetryable = expired.filter((j) => j.status === "retryable");
    for (const job of expired) {
      logger.warn(
        { jobId: job.id, jobKey: job.jobKey, status: job.status, attempt: job.attempt },
        "market_watcher_job_lease_recovered",
      );
    }
    marketWatcherJobsRecoveredTotal.inc(expired.length);

    const due = await this.repository.listDueRetryable(now, this.batchLimit);
    const seen = new Set(recoveredRetryable.map((j) => j.id));
    const candidates = [...recoveredRetryable, ...due.filter((j) => !seen.has(j.id))];

    let enqueued = 0;
    for (const job of candidates) {
      if (await this.hasLiveQueueJob(job)) continue;
      await this.queue.add("notify-watchers", this.toJobData(job), {
        jobId: `${job.jobKey}:recover:${job.attempt}`,
        removeOnComplete: false,
        removeOnFail: false,
      });
      enqueued++;
    }

    return { locked: true, recovered: expired.length, enqueued };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.sweepOnce()
        .catch((err) => logger.error({ err }, "market_watcher_sweep_failed"))
        .finally(() => {
          if (this.running) this.schedule();
        });
    }, this.intervalMs);
  }

  private async hasLiveQueueJob(job: MarketWatcherJob): Promise<boolean> {
    const ids = [
      job.jobKey,
      `${job.jobKey}:retry:${job.attempt}`,
      `${job.jobKey}:recover:${job.attempt}`,
    ];
    for (const id of ids) {
      const queued = await this.queue.getJob(id);
      if (queued && LIVE_STATES.has(await queued.getState())) return true;
    }
    return false;
  }

  private toJobData(job: MarketWatcherJob): MarketWatcherJobData {
    const prefix = `${job.marketId}:${job.eventType}:`;
    const eventRef = job.jobKey.startsWith(prefix) ? job.jobKey.slice(prefix.length) : job.jobKey;
    return {
      jobId: job.id,
      marketId: job.marketId,
      eventType: job.eventType,
      eventRef,
      jobKey: job.jobKey,
      payload: (job.payload ?? {}) as Record<string, unknown>,
    };
  }
}
