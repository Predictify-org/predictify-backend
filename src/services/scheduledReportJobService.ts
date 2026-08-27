import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { db as defaultDb } from "../db";
import {
  scheduledReportRuns,
  type ScheduledReportRun,
} from "../db/schema";
import {
  scheduledReportLeaseConflictsTotal,
  scheduledReportRetriesTotal,
  scheduledReportRunsTotal,
} from "../metrics/registry";
import { logger } from "../config/logger";
import { scheduledReportQueue } from "../queue";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_RETRY_BASE_MS = 30 * 1000;
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export type ScheduledReportRunStatus = "pending" | "running" | "retryable" | "succeeded" | "failed";

export interface ReportRunJobData {
  runId: string;
  scheduledReportId: string;
  runFor: string;
  scheduleKey: string;
}

export interface GeneratedReport {
  /** Stable reference to the stored output, never the report bytes themselves. */
  outputRef: string;
}

export interface ReportGeneratorInput {
  runId: string;
  scheduledReportId: string;
  runFor: Date;
  scheduleKey: string;
  attempt: number;
}

export type ReportGenerator = (input: ReportGeneratorInput) => Promise<GeneratedReport>;

export interface ReportRunRepository {
  createOrGetRun(input: {
    scheduledReportId: string;
    scheduleKey: string;
    runFor: Date;
  }): Promise<ScheduledReportRun>;
  claimRun(runId: string, leaseToken: string, now: Date, leaseMs: number): Promise<ScheduledReportRun | null>;
  markSucceeded(runId: string, leaseToken: string, outputRef: string, now: Date): Promise<boolean>;
  markFailed(input: {
    runId: string;
    leaseToken: string;
    error: string;
    now: Date;
    maxAttempts: number;
    nextAttemptAt: Date;
  }): Promise<{ status: "retryable" | "failed"; attempt: number } | null>;
}

type QueueLike = {
  add(name: string, data: ReportRunJobData, options?: Record<string, unknown>): Promise<unknown>;
};

/**
 * Production repository. Every state transition includes the lease token, so
 * a timed-out worker can never complete a run after a replacement owns it.
 */
export class DrizzleReportRunRepository implements ReportRunRepository {
  constructor(private readonly database: Db = defaultDb) {}

  async createOrGetRun(input: {
    scheduledReportId: string;
    scheduleKey: string;
    runFor: Date;
  }): Promise<ScheduledReportRun> {
    await this.database
      .insert(scheduledReportRuns)
      .values({
        scheduledReportId: input.scheduledReportId,
        scheduleKey: input.scheduleKey,
        runFor: input.runFor,
        status: "pending",
        nextAttemptAt: input.runFor,
      })
      .onConflictDoNothing({
        target: [scheduledReportRuns.scheduledReportId, scheduledReportRuns.runFor],
      });

    const [run] = await this.database
      .select()
      .from(scheduledReportRuns)
      .where(
        and(
          eq(scheduledReportRuns.scheduledReportId, input.scheduledReportId),
          eq(scheduledReportRuns.runFor, input.runFor),
        ),
      )
      .limit(1);

    if (!run) throw new Error("scheduled report run could not be created or loaded");
    return run;
  }

  async claimRun(runId: string, leaseToken: string, now: Date, leaseMs: number): Promise<ScheduledReportRun | null> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const [run] = await this.database
      .update(scheduledReportRuns)
      .set({
        status: "running",
        attempt: sql`${scheduledReportRuns.attempt} + 1`,
        leaseToken,
        leaseUntil,
        startedAt: sql`COALESCE(${scheduledReportRuns.startedAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledReportRuns.id, runId),
          or(
            eq(scheduledReportRuns.status, "pending"),
            and(eq(scheduledReportRuns.status, "retryable"), or(isNull(scheduledReportRuns.nextAttemptAt), lte(scheduledReportRuns.nextAttemptAt, now))),
            and(eq(scheduledReportRuns.status, "running"), or(isNull(scheduledReportRuns.leaseUntil), lt(scheduledReportRuns.leaseUntil, now))),
          ),
        ),
      )
      .returning();

    if (!run) scheduledReportLeaseConflictsTotal.inc();
    return run ?? null;
  }

  async markSucceeded(runId: string, leaseToken: string, outputRef: string, now: Date): Promise<boolean> {
    const result = await this.database
      .update(scheduledReportRuns)
      .set({ status: "succeeded", outputRef, completedAt: now, leaseToken: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(scheduledReportRuns.id, runId), eq(scheduledReportRuns.leaseToken, leaseToken), eq(scheduledReportRuns.status, "running")))
      .returning({ id: scheduledReportRuns.id });
    const succeeded = result.length === 1;
    if (succeeded) scheduledReportRunsTotal.inc({ status: "succeeded" });
    return succeeded;
  }

  async markFailed(input: {
    runId: string;
    leaseToken: string;
    error: string;
    now: Date;
    maxAttempts: number;
    nextAttemptAt: Date;
  }): Promise<{ status: "retryable" | "failed"; attempt: number } | null> {
    const [run] = await this.database
      .update(scheduledReportRuns)
      .set({
        status: sql`CASE WHEN ${scheduledReportRuns.attempt} >= ${input.maxAttempts} THEN 'failed' ELSE 'retryable' END`,
        lastError: input.error.slice(0, 2_000),
        nextAttemptAt: input.nextAttemptAt,
        completedAt: sql`CASE WHEN ${scheduledReportRuns.attempt} >= ${input.maxAttempts} THEN ${input.now} ELSE NULL END`,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: input.now,
      })
      .where(and(eq(scheduledReportRuns.id, input.runId), eq(scheduledReportRuns.leaseToken, input.leaseToken), eq(scheduledReportRuns.status, "running")))
      .returning({ status: scheduledReportRuns.status, attempt: scheduledReportRuns.attempt });

    if (!run) return null;
    const status = run.status as "retryable" | "failed";
    scheduledReportRetriesTotal.inc({ reason: status === "retryable" ? "error" : "exhausted" });
    if (status === "failed") scheduledReportRunsTotal.inc({ status });
    return { status, attempt: run.attempt };
  }
}

export function buildScheduleKey(scheduledReportId: string, runFor: Date): string {
  if (!scheduledReportId || Number.isNaN(runFor.getTime())) throw new Error("valid schedule identity and run time are required");
  return `${scheduledReportId}:${runFor.toISOString()}`;
}

export function retryDelayMs(attempt: number, baseMs = DEFAULT_RETRY_BASE_MS): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  if (!Number.isFinite(baseMs) || baseMs < 0) throw new Error("retry base must be non-negative");
  return Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** (attempt - 1));
}

export async function enqueueScheduledReportRun(
  scheduledReportId: string,
  runFor: Date,
  repository: ReportRunRepository = new DrizzleReportRunRepository(),
  queue: QueueLike = scheduledReportQueue,
): Promise<{ run: ScheduledReportRun; enqueued: boolean }> {
  const scheduleKey = buildScheduleKey(scheduledReportId, runFor);
  const run = await repository.createOrGetRun({ scheduledReportId, scheduleKey, runFor });
  if (run.status === "succeeded" || run.status === "failed") return { run, enqueued: false };

  await queue.add("generate", {
    runId: run.id,
    scheduledReportId,
    runFor: runFor.toISOString(),
    scheduleKey,
  }, { jobId: scheduleKey, removeOnComplete: false, removeOnFail: false });
  return { run, enqueued: true };
}

export interface RunCoordinatorOptions {
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  now?: () => Date;
  queue?: QueueLike;
}

export class ScheduledReportRunCoordinator {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly queue: QueueLike;

  constructor(private readonly repository: ReportRunRepository, options: RunCoordinatorOptions = {}) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.now = options.now ?? (() => new Date());
    this.queue = options.queue ?? scheduledReportQueue;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("maxAttempts must be positive");
  }

  async process(job: ReportRunJobData, generate: ReportGenerator): Promise<"skipped" | "succeeded" | "retryable" | "failed"> {
    const leaseToken = randomUUID();
    const claimed = await this.repository.claimRun(job.runId, leaseToken, this.now(), this.leaseMs);
    if (!claimed) return "skipped";

    try {
      const output = await generate({
        runId: claimed.id,
        scheduledReportId: claimed.scheduledReportId,
        runFor: claimed.runFor,
        scheduleKey: claimed.scheduleKey,
        attempt: claimed.attempt,
      });
      if (!output.outputRef || output.outputRef.length > 2_000) throw new Error("report generator returned an invalid output reference");
      const accepted = await this.repository.markSucceeded(claimed.id, leaseToken, output.outputRef, this.now());
      return accepted ? "succeeded" : "skipped";
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown report generation failure";
      const retryAt = new Date(this.now().getTime() + retryDelayMs(claimed.attempt, this.retryBaseMs));
      const failed = await this.repository.markFailed({ runId: claimed.id, leaseToken, error: message, now: this.now(), maxAttempts: this.maxAttempts, nextAttemptAt: retryAt });
      if (!failed) return "skipped";
      if (failed.status === "retryable") {
        await this.queue.add("generate", job, { jobId: `${job.scheduleKey}:retry:${failed.attempt}`, delay: retryAt.getTime() - this.now().getTime(), removeOnComplete: false, removeOnFail: false });
      }
      logger.warn({ runId: job.runId, attempt: failed.attempt, status: failed.status }, "scheduled report generation failed");
      return failed.status;
    }
  }
}
