/**
 * marketWatcherJobService.ts
 *
 * Durable, lease-backed market-watcher job processing service.
 * Guarantees that duplicate jobs are not executed upon worker failovers,
 * restarts, retries, or timeouts.
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { db as defaultDb } from "../db";
import {
  marketWatcherJobs,
  marketWatchers,
  notifications,
  type MarketWatcherJob,
} from "../db/schema";
import {
  marketWatcherJobRetriesTotal,
  marketWatcherJobRunsTotal,
  marketWatcherLeaseConflictsTotal,
  marketWatcherNotificationsTotal,
} from "../metrics/registry";
import { logger } from "../config/logger";
import { marketWatcherQueue } from "../queue";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_RETRY_BASE_MS = 30 * 1000;
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export type MarketWatcherJobStatus =
  | "pending"
  | "running"
  | "retryable"
  | "succeeded"
  | "failed";

export interface MarketWatcherJobData {
  jobId: string;
  marketId: string;
  eventType: string;
  eventRef: string;
  jobKey: string;
  payload?: Record<string, unknown>;
}

export interface MarketWatcherJobResult {
  watchersNotified: number;
}

export interface MarketWatcherJobHandlerInput extends MarketWatcherJobData {
  attempt: number;
}

export type MarketWatcherNotificationHandler = (
  input: MarketWatcherJobHandlerInput,
) => Promise<MarketWatcherJobResult>;

export interface MarketWatcherJobRepo {
  createOrGetJob(input: {
    marketId: string;
    jobKey: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): Promise<MarketWatcherJob>;
  claimJob(
    jobId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number,
  ): Promise<MarketWatcherJob | null>;
  markSucceeded(
    jobId: string,
    leaseToken: string,
    watchersNotified: number,
    now: Date,
  ): Promise<boolean>;
  markFailed(input: {
    jobId: string;
    leaseToken: string;
    error: string;
    now: Date;
    maxAttempts: number;
    nextAttemptAt: Date;
  }): Promise<{ status: "retryable" | "failed"; attempt: number } | null>;
  recoverExpiredLeases(now: Date): Promise<MarketWatcherJob[]>;
  getJob(jobId: string): Promise<MarketWatcherJob | null>;
}

export type QueueLike = {
  add(
    name: string,
    data: MarketWatcherJobData,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
};

/**
 * Production repository backed by Drizzle ORM.
 * Atomic lease token checking ensures failover workers can reclaim expired
 * leases safely while preventing delayed stale workers from committing duplicate state.
 */
export class DrizzleMarketWatcherJobRepo implements MarketWatcherJobRepo {
  constructor(private readonly database: Db = defaultDb) {}

  async createOrGetJob(input: {
    marketId: string;
    jobKey: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): Promise<MarketWatcherJob> {
    await this.database
      .insert(marketWatcherJobs)
      .values({
        marketId: input.marketId,
        jobKey: input.jobKey,
        eventType: input.eventType,
        payload: input.payload ?? {},
        status: "pending",
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({
        target: marketWatcherJobs.jobKey,
      });

    const [job] = await this.database
      .select()
      .from(marketWatcherJobs)
      .where(eq(marketWatcherJobs.jobKey, input.jobKey))
      .limit(1);

    if (!job) {
      throw new Error("market watcher job could not be created or loaded");
    }
    return job;
  }

  async claimJob(
    jobId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number,
  ): Promise<MarketWatcherJob | null> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const [job] = await this.database
      .update(marketWatcherJobs)
      .set({
        status: "running",
        attempt: sql`${marketWatcherJobs.attempt} + 1`,
        leaseToken,
        leaseUntil,
        startedAt: sql`COALESCE(${marketWatcherJobs.startedAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(marketWatcherJobs.id, jobId),
          or(
            eq(marketWatcherJobs.status, "pending"),
            and(
              eq(marketWatcherJobs.status, "retryable"),
              or(
                isNull(marketWatcherJobs.nextAttemptAt),
                lte(marketWatcherJobs.nextAttemptAt, now),
              ),
            ),
            and(
              eq(marketWatcherJobs.status, "running"),
              or(
                isNull(marketWatcherJobs.leaseUntil),
                lt(marketWatcherJobs.leaseUntil, now),
              ),
            ),
          ),
        ),
      )
      .returning();

    if (!job) {
      marketWatcherLeaseConflictsTotal.inc();
    }
    return job ?? null;
  }

  async markSucceeded(
    jobId: string,
    leaseToken: string,
    watchersNotified: number,
    now: Date,
  ): Promise<boolean> {
    const result = await this.database
      .update(marketWatcherJobs)
      .set({
        status: "succeeded",
        watchersNotified,
        completedAt: now,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(marketWatcherJobs.id, jobId),
          eq(marketWatcherJobs.leaseToken, leaseToken),
          eq(marketWatcherJobs.status, "running"),
        ),
      )
      .returning({ id: marketWatcherJobs.id });

    const succeeded = result.length === 1;
    if (succeeded) {
      marketWatcherJobRunsTotal.inc({ status: "succeeded" });
      if (watchersNotified > 0) {
        marketWatcherNotificationsTotal.inc(watchersNotified);
      }
    }
    return succeeded;
  }

  async markFailed(input: {
    jobId: string;
    leaseToken: string;
    error: string;
    now: Date;
    maxAttempts: number;
    nextAttemptAt: Date;
  }): Promise<{ status: "retryable" | "failed"; attempt: number } | null> {
    const [job] = await this.database
      .update(marketWatcherJobs)
      .set({
        status: sql`CASE WHEN ${marketWatcherJobs.attempt} >= ${input.maxAttempts} THEN 'failed' ELSE 'retryable' END`,
        lastError: input.error.slice(0, 2000),
        nextAttemptAt: input.nextAttemptAt,
        completedAt: sql`CASE WHEN ${marketWatcherJobs.attempt} >= ${input.maxAttempts} THEN ${input.now} ELSE NULL END`,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(marketWatcherJobs.id, input.jobId),
          eq(marketWatcherJobs.leaseToken, input.leaseToken),
          eq(marketWatcherJobs.status, "running"),
        ),
      )
      .returning({
        status: marketWatcherJobs.status,
        attempt: marketWatcherJobs.attempt,
      });

    if (!job) return null;

    const status = job.status as "retryable" | "failed";
    marketWatcherJobRetriesTotal.inc({
      reason: status === "retryable" ? "error" : "exhausted",
    });
    if (status === "failed") {
      marketWatcherJobRunsTotal.inc({ status: "failed" });
    }
    return { status, attempt: job.attempt };
  }

  async recoverExpiredLeases(now: Date): Promise<MarketWatcherJob[]> {
    return this.database
      .update(marketWatcherJobs)
      .set({
        status: "retryable",
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(marketWatcherJobs.status, "running"),
          lt(marketWatcherJobs.leaseUntil, now),
        ),
      )
      .returning();
  }

  async getJob(jobId: string): Promise<MarketWatcherJob | null> {
    const [job] = await this.database
      .select()
      .from(marketWatcherJobs)
      .where(eq(marketWatcherJobs.id, jobId))
      .limit(1);
    return job ?? null;
  }
}

/**
 * Builds a deterministic job key for market watcher operations.
 */
export function buildWatcherJobKey(
  marketId: string,
  eventType: string,
  eventRef: string,
): string {
  if (!marketId || !eventType || !eventRef) {
    throw new Error("marketId, eventType, and eventRef are required to build a watcher job key");
  }
  return `${marketId}:${eventType}:${eventRef}`;
}

/**
 * Exponential backoff calculation with upper bounding.
 */
export function retryDelayMs(
  attempt: number,
  baseMs = DEFAULT_RETRY_BASE_MS,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new Error("retry base must be non-negative");
  }
  return Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** (attempt - 1));
}

/**
 * Enqueues a market watcher notification job idempotently.
 * If a job already exists for this event identity, it will not be duplicated.
 */
export async function enqueueMarketWatcherJob(
  marketId: string,
  eventType: string,
  eventRef: string,
  payload: Record<string, unknown> = {},
  repository: MarketWatcherJobRepo = new DrizzleMarketWatcherJobRepo(),
  queue: QueueLike = marketWatcherQueue,
): Promise<{ job: MarketWatcherJob; enqueued: boolean }> {
  const jobKey = buildWatcherJobKey(marketId, eventType, eventRef);
  const job = await repository.createOrGetJob({
    marketId,
    jobKey,
    eventType,
    payload,
  });

  if (job.status === "succeeded" || job.status === "failed") {
    return { job, enqueued: false };
  }

  await queue.add(
    "notify-watchers",
    {
      jobId: job.id,
      marketId,
      eventType,
      eventRef,
      jobKey,
      payload,
    },
    {
      jobId: jobKey,
      removeOnComplete: false,
      removeOnFail: false,
    },
  );

  return { job, enqueued: true };
}

export interface WatcherCoordinatorOptions {
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  now?: () => Date;
  queue?: QueueLike;
}

/**
 * Coordinator managing the end-to-end execution of market watcher jobs.
 * Enforces single-active-worker leases, safe failover recovery, and idempotent retries.
 */
export class MarketWatcherJobCoordinator {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly queue: QueueLike;

  constructor(
    private readonly repository: MarketWatcherJobRepo,
    options: WatcherCoordinatorOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.now = options.now ?? (() => new Date());
    this.queue = options.queue ?? marketWatcherQueue;

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be positive");
    }
  }

  /**
   * Process a market watcher job payload through the provided handler.
   */
  async process(
    job: MarketWatcherJobData,
    handler: MarketWatcherNotificationHandler = defaultMarketWatcherHandler,
  ): Promise<"skipped" | "succeeded" | "retryable" | "failed"> {
    const leaseToken = randomUUID();
    const claimed = await this.repository.claimJob(
      job.jobId,
      leaseToken,
      this.now(),
      this.leaseMs,
    );

    if (!claimed) {
      logger.info({ jobId: job.jobId, jobKey: job.jobKey }, "market_watcher_job_lease_skipped");
      return "skipped";
    }

    try {
      const result = await handler({
        jobId: claimed.id,
        marketId: claimed.marketId,
        eventType: claimed.eventType,
        eventRef: job.eventRef,
        jobKey: claimed.jobKey,
        payload: job.payload,
        attempt: claimed.attempt,
      });

      if (!Number.isInteger(result.watchersNotified) || result.watchersNotified < 0) {
        throw new Error("invalid watchersNotified count returned by handler");
      }

      const accepted = await this.repository.markSucceeded(
        claimed.id,
        leaseToken,
        result.watchersNotified,
        this.now(),
      );

      if (!accepted) {
        logger.warn(
          { jobId: job.jobId, leaseToken },
          "market_watcher_job_commit_rejected_lease_expired",
        );
        return "skipped";
      }

      return "succeeded";
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown market watcher notification failure";
      const retryAt = new Date(
        this.now().getTime() + retryDelayMs(claimed.attempt, this.retryBaseMs),
      );

      const failed = await this.repository.markFailed({
        jobId: claimed.id,
        leaseToken,
        error: message,
        now: this.now(),
        maxAttempts: this.maxAttempts,
        nextAttemptAt: retryAt,
      });

      if (!failed) {
        return "skipped";
      }

      if (failed.status === "retryable") {
        await this.queue.add("notify-watchers", job, {
          jobId: `${job.jobKey}:retry:${failed.attempt}`,
          delay: Math.max(0, retryAt.getTime() - this.now().getTime()),
          removeOnComplete: false,
          removeOnFail: false,
        });
      }

      logger.warn(
        {
          jobId: job.jobId,
          attempt: failed.attempt,
          status: failed.status,
          err: message,
        },
        "market_watcher_job_failed",
      );

      return failed.status;
    }
  }
}

/**
 * Default notification handler: queries subscribers for the market and
 * creates notification records for each watcher in batches.
 */
export async function defaultMarketWatcherHandler(
  input: MarketWatcherJobHandlerInput,
  database: Db = defaultDb,
): Promise<MarketWatcherJobResult> {
  const watchers = await database
    .select({ userId: marketWatchers.userId })
    .from(marketWatchers)
    .where(eq(marketWatchers.marketId, input.marketId));

  if (watchers.length === 0) {
    return { watchersNotified: 0 };
  }

  const title = `Market Update: ${input.marketId}`;
  const body = `Event [${input.eventType}] occurred on watched market ${input.marketId}`;

  const rows = watchers.map((w) => ({
    userId: w.userId,
    type: input.eventType,
    title,
    body,
    data: input.payload ?? {},
  }));

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await database.insert(notifications).values(chunk);
  }

  return { watchersNotified: watchers.length };
}
