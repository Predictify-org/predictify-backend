jest.mock("../src/queue", () => ({
  marketWatcherQueue: { add: jest.fn().mockResolvedValue(undefined) },
  marketWatcherQueueName: "market-watcher-jobs",
  redisConnection: { on: jest.fn() },
}));

import { randomUUID } from "node:crypto";
import {
  buildWatcherJobKey,
  retryDelayMs,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LEASE_MS,
  DEFAULT_RETRY_BASE_MS,
  MAX_RETRY_DELAY_MS,
  type MarketWatcherJobData,
  type MarketWatcherJobRepo,
  MarketWatcherJobCoordinator,
  enqueueMarketWatcherJob,
  defaultMarketWatcherHandler,
  LeaseLostError,
} from "../src/services/marketWatcherJobService";
import { MarketWatcherLeaseSweeper } from "../src/jobs/marketWatcherLeaseSweeper";
import type { MarketWatcherJob } from "../src/db/schema";

class InMemoryMarketWatcherJobRepo implements MarketWatcherJobRepo {
  public jobs = new Map<string, MarketWatcherJob>();
  public leaseConflicts = 0;

  async createOrGetJob(input: {
    marketId: string;
    jobKey: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): Promise<MarketWatcherJob> {
    const existing = Array.from(this.jobs.values()).find((j) => j.jobKey === input.jobKey);
    if (existing) return existing;

    const now = new Date();
    const job: MarketWatcherJob = {
      id: randomUUID(),
      marketId: input.marketId,
      jobKey: input.jobKey,
      eventType: input.eventType,
      status: "pending",
      attempt: 0,
      leaseToken: null,
      leaseUntil: null,
      startedAt: null,
      completedAt: null,
      nextAttemptAt: now,
      watchersNotified: 0,
      payload: input.payload ?? {},
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async claimJob(
    jobId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number,
  ): Promise<MarketWatcherJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const isPending = job.status === "pending";
    const isRetryableReady =
      job.status === "retryable" && (!job.nextAttemptAt || job.nextAttemptAt <= now);
    const isRunningExpired =
      job.status === "running" && (!job.leaseUntil || job.leaseUntil < now);

    if (!isPending && !isRetryableReady && !isRunningExpired) {
      this.leaseConflicts++;
      return null;
    }

    job.status = "running";
    job.attempt += 1;
    job.leaseToken = leaseToken;
    job.leaseUntil = new Date(now.getTime() + leaseMs);
    job.startedAt = job.startedAt ?? now;
    job.updatedAt = now;
    return { ...job };
  }

  async markSucceeded(
    jobId: string,
    leaseToken: string,
    watchersNotified: number,
    now: Date,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) {
      return false;
    }

    job.status = "succeeded";
    job.watchersNotified = watchersNotified;
    job.completedAt = now;
    job.leaseToken = null;
    job.leaseUntil = null;
    job.updatedAt = now;
    return true;
  }

  async markFailed(input: {
    jobId: string;
    leaseToken: string;
    error: string;
    now: Date;
    maxAttempts: number;
    nextAttemptAt: Date;
  }): Promise<{ status: "retryable" | "failed"; attempt: number } | null> {
    const job = this.jobs.get(input.jobId);
    if (!job || job.status !== "running" || job.leaseToken !== input.leaseToken) {
      return null;
    }

    const isTerminal = job.attempt >= input.maxAttempts;
    job.status = isTerminal ? "failed" : "retryable";
    job.lastError = input.error;
    job.nextAttemptAt = input.nextAttemptAt;
    job.completedAt = isTerminal ? input.now : null;
    job.leaseToken = null;
    job.leaseUntil = null;
    job.updatedAt = input.now;
    return { status: job.status, attempt: job.attempt };
  }

  async renewLease(
    jobId: string,
    leaseToken: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.status !== "running" ||
      job.leaseToken !== leaseToken ||
      !job.leaseUntil ||
      job.leaseUntil < now
    ) {
      return false;
    }
    job.leaseUntil = new Date(now.getTime() + leaseMs);
    return true;
  }

  async listDueRetryable(now: Date, limit: number): Promise<MarketWatcherJob[]> {
    return Array.from(this.jobs.values())
      .filter((j) => j.status === "retryable" && (!j.nextAttemptAt || j.nextAttemptAt <= now))
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  async recoverExpiredLeases(
    now: Date,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ): Promise<MarketWatcherJob[]> {
    const recovered: MarketWatcherJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.leaseUntil && job.leaseUntil < now) {
        job.status = job.attempt >= maxAttempts ? "failed" : "retryable";
        job.completedAt = job.status === "failed" ? now : null;
        job.leaseToken = null;
        job.leaseUntil = null;
        job.nextAttemptAt = now;
        job.updatedAt = now;
        recovered.push({ ...job });
      }
    }
    return recovered;
  }

  async getJob(jobId: string): Promise<MarketWatcherJob | null> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }
}

describe("marketWatcherJobService", () => {
  describe("buildWatcherJobKey", () => {
    it("builds a deterministic key from marketId, eventType, and eventRef", () => {
      const key = buildWatcherJobKey("mkt-123", "market.resolved", "tx-456");
      expect(key).toBe("mkt-123:market.resolved:tx-456");
    });

    it("throws error for missing arguments", () => {
      expect(() => buildWatcherJobKey("", "market.resolved", "ref")).toThrow();
      expect(() => buildWatcherJobKey("mkt-1", "", "ref")).toThrow();
      expect(() => buildWatcherJobKey("mkt-1", "market.resolved", "")).toThrow();
    });
  });

  describe("retryDelayMs", () => {
    it("calculates exponential backoff with default base", () => {
      expect(retryDelayMs(1)).toBe(30_000);
      expect(retryDelayMs(2)).toBe(60_000);
      expect(retryDelayMs(3)).toBe(120_000);
    });

    it("caps delay at MAX_RETRY_DELAY_MS", () => {
      expect(retryDelayMs(20, DEFAULT_RETRY_BASE_MS)).toBe(MAX_RETRY_DELAY_MS);
    });

    it("throws error for invalid attempt or negative base", () => {
      expect(() => retryDelayMs(0)).toThrow();
      expect(() => retryDelayMs(-1)).toThrow();
      expect(() => retryDelayMs(1, -100)).toThrow();
    });
  });

  describe("enqueueMarketWatcherJob", () => {
    it("creates and enqueues job idempotently", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const mockQueue = { add: jest.fn().mockResolvedValue({}) };

      const result1 = await enqueueMarketWatcherJob(
        "mkt-1",
        "market.resolved",
        "evt-1",
        { winner: "YES" },
        repo,
        mockQueue,
      );

      expect(result1.enqueued).toBe(true);
      expect(result1.job.marketId).toBe("mkt-1");
      expect(mockQueue.add).toHaveBeenCalledTimes(1);

      // Re-enqueuing duplicate
      const result2 = await enqueueMarketWatcherJob(
        "mkt-1",
        "market.resolved",
        "evt-1",
        { winner: "YES" },
        repo,
        mockQueue,
      );

      expect(result2.job.id).toBe(result1.job.id);
    });

    it("does not enqueue if job is already in terminal succeeded state", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const mockQueue = { add: jest.fn().mockResolvedValue({}) };

      const { job } = await enqueueMarketWatcherJob(
        "mkt-1",
        "market.resolved",
        "evt-1",
        {},
        repo,
        mockQueue,
      );

      const claimed = await repo.claimJob(job.id, "token-1", new Date(), 5000);
      await repo.markSucceeded(claimed!.id, "token-1", 5, new Date());

      const result = await enqueueMarketWatcherJob(
        "mkt-1",
        "market.resolved",
        "evt-1",
        {},
        repo,
        mockQueue,
      );

      expect(result.enqueued).toBe(false);
      expect(result.job.status).toBe("succeeded");
    });
  });

  describe("MarketWatcherJobCoordinator", () => {
    it("claims, executes notification handler, and marks succeeded", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const coordinator = new MarketWatcherJobCoordinator(repo);

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      const handler = jest.fn().mockResolvedValue({ watchersNotified: 10 });

      const outcome = await coordinator.process(
        {
          jobId: job.id,
          marketId: job.marketId,
          eventType: job.eventType,
          eventRef: "evt-1",
          jobKey: job.jobKey,
        },
        handler,
      );

      expect(outcome).toBe("succeeded");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          marketId: "mkt-1",
          attempt: 1,
        }),
      );

      const updated = await repo.getJob(job.id);
      expect(updated?.status).toBe("succeeded");
      expect(updated?.watchersNotified).toBe(10);
      expect(updated?.completedAt).toBeDefined();
    });

    it("skips execution when lease is already owned by another active worker", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const coordinator = new MarketWatcherJobCoordinator(repo);

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      // Worker 1 claims lease
      await repo.claimJob(job.id, "worker-1-token", new Date(), DEFAULT_LEASE_MS);

      // Worker 2 attempts processing
      const handler = jest.fn();
      const outcome = await coordinator.process(
        {
          jobId: job.id,
          marketId: job.marketId,
          eventType: job.eventType,
          eventRef: "evt-1",
          jobKey: job.jobKey,
        },
        handler,
      );

      expect(outcome).toBe("skipped");
      expect(handler).not.toHaveBeenCalled();
    });

    it("reclaims expired lease upon worker failover and completes successfully", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const now = new Date("2026-08-29T10:00:00Z");
      const coordinator = new MarketWatcherJobCoordinator(repo, { now: () => now });

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      // Old Worker 1 claimed lease at 09:50 with 5 min lease (expired at 09:55)
      const oldTime = new Date("2026-08-29T09:50:00Z");
      await repo.claimJob(job.id, "worker-1-token", oldTime, 5 * 60 * 1000);

      // Worker 2 (failover worker) processes at 10:00:00Z
      const handler = jest.fn().mockResolvedValue({ watchersNotified: 3 });
      const outcome = await coordinator.process(
        {
          jobId: job.id,
          marketId: job.marketId,
          eventType: job.eventType,
          eventRef: "evt-1",
          jobKey: job.jobKey,
        },
        handler,
      );

      expect(outcome).toBe("succeeded");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          attempt: 2, // Incremented upon reclaim
        }),
      );

      const finalJob = await repo.getJob(job.id);
      expect(finalJob?.status).toBe("succeeded");
      expect(finalJob?.watchersNotified).toBe(3);
    });

    it("rejects commit from a stale worker whose lease expired and was claimed by a failover worker", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      // Worker 1 claims job
      const worker1Claim = await repo.claimJob(job.id, "token-1", new Date(), 1000);
      expect(worker1Claim).not.toBeNull();

      // Time passes, lease expires, Worker 2 reclaims job
      const future = new Date(Date.now() + 5000);
      const worker2Claim = await repo.claimJob(job.id, "token-2", future, DEFAULT_LEASE_MS);
      expect(worker2Claim).not.toBeNull();

      // Worker 1 now attempts to mark succeeded with old token-1 -> rejected!
      const worker1Success = await repo.markSucceeded(job.id, "token-1", 10, future);
      expect(worker1Success).toBe(false);

      // Worker 2 completes with token-2 -> accepted!
      const worker2Success = await repo.markSucceeded(job.id, "token-2", 10, future);
      expect(worker2Success).toBe(true);

      const finalJob = await repo.getJob(job.id);
      expect(finalJob?.status).toBe("succeeded");
    });

    it("handles failure with retry and exponential backoff delay", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const mockQueue = { add: jest.fn().mockResolvedValue({}) };
      const now = new Date("2026-08-29T10:00:00.000Z");
      const coordinator = new MarketWatcherJobCoordinator(repo, {
        now: () => now,
        queue: mockQueue,
        maxAttempts: 3,
        retryBaseMs: 10_000,
      });

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      const handler = jest.fn().mockRejectedValue(new Error("Network connection dropped"));

      const outcome = await coordinator.process(
        {
          jobId: job.id,
          marketId: job.marketId,
          eventType: job.eventType,
          eventRef: "evt-1",
          jobKey: job.jobKey,
        },
        handler,
      );

      expect(outcome).toBe("retryable");
      const failedJob = await repo.getJob(job.id);
      expect(failedJob?.status).toBe("retryable");
      expect(failedJob?.attempt).toBe(1);
      expect(failedJob?.lastError).toBe("Network connection dropped");
      expect(failedJob?.nextAttemptAt?.toISOString()).toBe("2026-08-29T10:00:10.000Z");

      expect(mockQueue.add).toHaveBeenCalledWith(
        "notify-watchers",
        expect.objectContaining({ jobId: job.id }),
        expect.objectContaining({
          jobId: `${job.jobKey}:retry:1`,
          delay: 10_000,
        }),
      );
    });

    it("marks terminal failed status upon exhausting max attempts", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const mockQueue = { add: jest.fn().mockResolvedValue({}) };
      let currentTime = new Date("2026-08-29T10:00:00.000Z");
      const coordinator = new MarketWatcherJobCoordinator(repo, {
        now: () => currentTime,
        queue: mockQueue,
        maxAttempts: 2,
        retryBaseMs: 10_000,
      });

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      const handler = jest.fn().mockRejectedValue(new Error("Persistent database failure"));

      // Attempt 1: retryable
      const outcome1 = await coordinator.process(
        {
          jobId: job.id,
          marketId: job.marketId,
          eventType: job.eventType,
          eventRef: "evt-1",
          jobKey: job.jobKey,
        },
        handler,
      );
      expect(outcome1).toBe("retryable");

      // Advance time beyond nextAttemptAt (10s)
      currentTime = new Date("2026-08-29T10:00:15.000Z");

      // Attempt 2: exhausted -> failed
      const outcome2 = await coordinator.process(
        {
          jobId: job.id,
          marketId: job.marketId,
          eventType: job.eventType,
          eventRef: "evt-1",
          jobKey: job.jobKey,
        },
        handler,
      );

      expect(outcome2).toBe("failed");
      const failedJob = await repo.getJob(job.id);
      expect(failedJob?.status).toBe("failed");
      expect(failedJob?.attempt).toBe(2);
      expect(failedJob?.completedAt).toBeDefined();
    });

    it("recovers expired leases via recoverExpiredLeases", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const now = new Date("2026-08-29T12:00:00Z");

      const job = await repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

      // Claimed with expired lease
      await repo.claimJob(job.id, "token-x", new Date("2026-08-29T11:00:00Z"), 60_000);

      const recovered = await repo.recoverExpiredLeases(now);
      expect(recovered.length).toBe(1);
      expect(recovered[0].status).toBe("retryable");
      expect(recovered[0].leaseToken).toBeNull();
    });
  });

  describe("recovery, renewal and conflict retry", () => {
    const T0 = new Date("2026-08-29T10:00:00.000Z");
    const dataFor = (job: MarketWatcherJob): MarketWatcherJobData => ({
      jobId: job.id,
      marketId: job.marketId,
      eventType: job.eventType,
      eventRef: "evt-1",
      jobKey: job.jobKey,
    });
    const newJob = (repo: InMemoryMarketWatcherJobRepo) =>
      repo.createOrGetJob({
        marketId: "mkt-1",
        jobKey: "mkt-1:market.resolved:evt-1",
        eventType: "market.resolved",
      });

    it("recovers a crashed job via the sweeper, re-enqueues with a :recover: id, and succeeds", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const job = await newJob(repo);
      // Worker crashed: claimed, lease 1 minute, never completed.
      await repo.claimJob(job.id, "dead-worker", T0, 60_000);

      const added: Array<{ data: MarketWatcherJobData; opts: Record<string, unknown> }> = [];
      const queue = {
        add: jest.fn(async (_n: string, data: MarketWatcherJobData, opts: Record<string, unknown>) => {
          added.push({ data, opts });
        }),
        // The original deterministic id exists but is completed.
        getJob: jest.fn(async () => ({ getState: async () => "completed" })),
      };
      let now = new Date(T0.getTime() + 120_000);
      const sweeper = new MarketWatcherLeaseSweeper(repo, {
        queue,
        lock: { acquire: async () => true },
        intervalMs: 1000,
        now: () => now,
      });

      const result = await sweeper.sweepOnce();
      expect(result).toEqual({ locked: true, recovered: 1, enqueued: 1 });
      expect((await repo.getJob(job.id))?.status).toBe("retryable");
      expect(added[0].opts.jobId).toBe(`${job.jobKey}:recover:1`);

      const coordinator = new MarketWatcherJobCoordinator(repo, { now: () => now, queue });
      const handler = jest.fn().mockResolvedValue({ watchersNotified: 2 });
      now = new Date(now.getTime() + 1000);
      expect(await coordinator.process(added[0].data, handler)).toBe("succeeded");
      expect((await repo.getJob(job.id))?.status).toBe("succeeded");
    });

    it("fails a poison job after maxAttempts including recovered attempts", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const job = await newJob(repo);
      const queue = {
        add: jest.fn().mockResolvedValue({}),
        getJob: jest.fn().mockResolvedValue(null),
      };
      let now = T0;
      const sweeper = new MarketWatcherLeaseSweeper(repo, {
        queue,
        lock: { acquire: async () => true },
        intervalMs: 1000,
        maxAttempts: 2,
        now: () => now,
      });

      for (let i = 0; i < 2; i++) {
        await repo.claimJob(job.id, `dead-${i}`, now, 1000);
        now = new Date(now.getTime() + 5000);
        await sweeper.sweepOnce();
      }

      const final = await repo.getJob(job.id);
      expect(final?.status).toBe("failed");
      expect(final?.attempt).toBe(2);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("schedules a delayed recover re-add at lease_until + 1s on a live lease conflict", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const job = await newJob(repo);
      await repo.claimJob(job.id, "holder", T0, 60_000);
      const queue = { add: jest.fn().mockResolvedValue({}) };
      const now = new Date(T0.getTime() + 10_000);
      const coordinator = new MarketWatcherJobCoordinator(repo, { now: () => now, queue });
      const handler = jest.fn();

      expect(await coordinator.process(dataFor(job), handler)).toBe("skipped");
      expect(handler).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(1);
      const [, , opts] = queue.add.mock.calls[0];
      expect(opts.delay).toBe(51_000);
      expect(String(opts.jobId)).toContain(`${job.jobKey}:recover:1:`);
    });

    it("does not reschedule when the conflicting job is not running", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const job = await newJob(repo);
      await repo.claimJob(job.id, "holder", T0, 60_000);
      await repo.markSucceeded(job.id, "holder", 1, T0);
      const queue = { add: jest.fn() };
      const coordinator = new MarketWatcherJobCoordinator(repo, { now: () => T0, queue });

      expect(await coordinator.process(dataFor(job), jest.fn())).toBe("skipped");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("renews the lease between batches of a long fan-out and succeeds once", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const job = await newJob(repo);
      let now = T0;
      const coordinator = new MarketWatcherJobCoordinator(repo, {
        now: () => now,
        leaseMs: 1000,
        queue: { add: jest.fn() },
      });
      const batches = jest.fn();
      const handler = async (input: { heartbeat?: () => Promise<void> }) => {
        for (let i = 0; i < 3; i++) {
          if (i > 0) await input.heartbeat?.();
          batches();
          now = new Date(now.getTime() + 800); // each batch nearly exhausts the lease
        }
        return { watchersNotified: 3 };
      };

      expect(await coordinator.process(dataFor(job), handler)).toBe("succeeded");
      expect(batches).toHaveBeenCalledTimes(3);
      expect((await repo.getJob(job.id))?.status).toBe("succeeded");
    });

    it("stops before the next batch and returns skipped when renewal fails", async () => {
      const repo = new InMemoryMarketWatcherJobRepo();
      const job = await newJob(repo);
      let now = T0;
      const coordinator = new MarketWatcherJobCoordinator(repo, {
        now: () => now,
        leaseMs: 1000,
        queue: { add: jest.fn() },
      });
      const batches = jest.fn();
      const handler = async (input: { heartbeat?: () => Promise<void> }) => {
        for (let i = 0; i < 3; i++) {
          if (i > 0) await input.heartbeat?.();
          batches();
          now = new Date(now.getTime() + 2000); // lease expires during the batch
        }
        return { watchersNotified: 3 };
      };

      expect(await coordinator.process(dataFor(job), handler)).toBe("skipped");
      expect(batches).toHaveBeenCalledTimes(1);
      expect((await repo.getJob(job.id))?.status).toBe("running");
    });

    it("defaultMarketWatcherHandler heartbeats between batches and stops on LeaseLostError", async () => {
      const watchers = [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }];
      const values = jest.fn().mockResolvedValue(undefined);
      const database = {
        select: () => ({ from: () => ({ where: async () => watchers }) }),
        insert: () => ({ values }),
      } as never;
      const base = {
        jobId: "j",
        marketId: "m",
        eventType: "e",
        eventRef: "r",
        jobKey: "m:e:r",
        attempt: 1,
      };

      const heartbeat = jest.fn().mockResolvedValue(undefined);
      const ok = await defaultMarketWatcherHandler({ ...base, heartbeat }, database, 1);
      expect(ok.watchersNotified).toBe(3);
      expect(values).toHaveBeenCalledTimes(3);
      expect(heartbeat).toHaveBeenCalledTimes(2);

      values.mockClear();
      const lost = jest.fn().mockRejectedValue(new LeaseLostError());
      await expect(
        defaultMarketWatcherHandler({ ...base, heartbeat: lost }, database, 1),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(values).toHaveBeenCalledTimes(1);
    });

    it("returns zero without heartbeat when there are no watchers", async () => {
      const database = {
        select: () => ({ from: () => ({ where: async () => [] }) }),
      } as never;
      const res = await defaultMarketWatcherHandler(
        { jobId: "j", marketId: "m", eventType: "e", eventRef: "r", jobKey: "k", attempt: 1 },
        database,
      );
      expect(res.watchersNotified).toBe(0);
    });
  });
});
