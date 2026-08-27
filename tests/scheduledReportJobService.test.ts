jest.mock("../src/queue", () => ({
  scheduledReportQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

import {
  buildScheduleKey,
  DEFAULT_MAX_ATTEMPTS,
  retryDelayMs,
  ScheduledReportRunCoordinator,
  type ReportRunJobData,
  type ReportRunRepository,
} from "../src/services/scheduledReportJobService";
import type { ScheduledReportRun } from "../src/db/schema";

function makeRun(overrides: Partial<ScheduledReportRun> = {}): ScheduledReportRun {
  const now = new Date("2026-08-24T10:00:00.000Z");
  return {
    id: "run-1",
    scheduledReportId: "schedule-1",
    scheduleKey: "schedule-1:2026-08-24T10:00:00.000Z",
    runFor: now,
    status: "pending",
    attempt: 0,
    leaseToken: null,
    leaseUntil: null,
    startedAt: null,
    completedAt: null,
    nextAttemptAt: now,
    outputRef: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeRepository implements ReportRunRepository {
  run = makeRun();
  claimCalls: Array<{ runId: string; token: string }> = [];
  successes: Array<{ runId: string; token: string; outputRef: string }> = [];
  failures: Array<{ runId: string; token: string; error: string }> = [];
  claimEnabled = true;
  failStatus: "retryable" | "failed" = "retryable";

  async createOrGetRun(): Promise<ScheduledReportRun> { return this.run; }

  async claimRun(runId: string, token: string): Promise<ScheduledReportRun | null> {
    this.claimCalls.push({ runId, token });
    if (!this.claimEnabled) return null;
    this.run = { ...this.run, status: "running", attempt: this.run.attempt + 1, leaseToken: token };
    return this.run;
  }

  async markSucceeded(runId: string, token: string, outputRef: string): Promise<boolean> {
    this.successes.push({ runId, token, outputRef });
    if (this.run.leaseToken !== token || this.run.status !== "running") return false;
    this.run = { ...this.run, status: "succeeded", outputRef, leaseToken: null };
    return true;
  }

  async markFailed(input: { runId: string; leaseToken: string; error: string; maxAttempts: number }): Promise<{ status: "retryable" | "failed"; attempt: number } | null> {
    this.failures.push({ runId: input.runId, token: input.leaseToken, error: input.error });
    if (this.run.leaseToken !== input.leaseToken || this.run.status !== "running") return null;
    this.run = { ...this.run, status: this.failStatus, leaseToken: null, lastError: input.error };
    return { status: this.failStatus, attempt: this.run.attempt };
  }
}

const job: ReportRunJobData = {
  runId: "run-1",
  scheduledReportId: "schedule-1",
  runFor: "2026-08-24T10:00:00.000Z",
  scheduleKey: "schedule-1:2026-08-24T10:00:00.000Z",
};

describe("scheduled report run identity", () => {
  it("is stable for equivalent UTC instants", () => {
    expect(buildScheduleKey("schedule-1", new Date("2026-08-24T10:00:00Z"))).toBe(job.scheduleKey);
    expect(buildScheduleKey("schedule-1", new Date("2026-08-24T05:00:00-05:00"))).toBe(job.scheduleKey);
  });

  it("rejects missing identity and invalid dates", () => {
    expect(() => buildScheduleKey("", new Date())).toThrow("valid schedule identity");
    expect(() => buildScheduleKey("schedule-1", new Date("invalid"))).toThrow("valid schedule identity");
  });

  it("uses bounded exponential retry delays", () => {
    expect(retryDelayMs(1, 100)).toBe(100);
    expect(retryDelayMs(4, 100)).toBe(800);
    expect(retryDelayMs(30, 100)).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(() => retryDelayMs(0)).toThrow("positive integer");
    expect(() => retryDelayMs(1, -1)).toThrow("non-negative");
  });
});

describe("ScheduledReportRunCoordinator", () => {
  function makeCoordinator(repository: FakeRepository, queue = { add: jest.fn().mockResolvedValue(undefined) }) {
    return { coordinator: new ScheduledReportRunCoordinator(repository, { now: () => new Date("2026-08-24T10:00:00Z"), queue, retryBaseMs: 10 }), queue };
  }

  it("claims, generates, and completes exactly once", async () => {
    const repository = new FakeRepository();
    const { coordinator, queue } = makeCoordinator(repository);
    const result = await coordinator.process(job, async (input) => ({ outputRef: `blob://${input.scheduleKey}` }));
    expect(result).toBe("succeeded");
    expect(repository.claimCalls).toHaveLength(1);
    expect(repository.successes[0].outputRef).toContain(job.scheduleKey);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("skips an overlapping worker when the lease is owned elsewhere", async () => {
    const repository = new FakeRepository();
    repository.claimEnabled = false;
    const { coordinator } = makeCoordinator(repository);
    const generator = jest.fn().mockResolvedValue({ outputRef: "blob://never" });
    await expect(coordinator.process(job, generator)).resolves.toBe("skipped");
    expect(generator).not.toHaveBeenCalled();
  });

  it("re-enqueues a retry with a distinct queue id", async () => {
    const repository = new FakeRepository();
    const { coordinator, queue } = makeCoordinator(repository);
    const result = await coordinator.process(job, async () => { throw new Error("temporary timeout"); });
    expect(result).toBe("retryable");
    expect(repository.failures[0].error).toBe("temporary timeout");
    expect(queue.add).toHaveBeenCalledWith("generate", job, expect.objectContaining({ jobId: `${job.scheduleKey}:retry:1` }));
  });

  it("marks retry exhaustion terminal and does not enqueue more work", async () => {
    const repository = new FakeRepository();
    repository.failStatus = "failed";
    const { coordinator, queue } = makeCoordinator(repository);
    await expect(coordinator.process(job, async () => { throw new Error("permanent failure"); })).resolves.toBe("failed");
    expect(queue.add).not.toHaveBeenCalled();
    expect(repository.run.status).toBe("failed");
  });

  it("does not acknowledge output when lease ownership is lost", async () => {
    const repository = new FakeRepository();
    const { coordinator, queue } = makeCoordinator(repository);
    const generator = jest.fn(async () => {
      repository.run = { ...repository.run, leaseToken: "replacement-token", status: "running" };
      return { outputRef: "blob://old-worker" };
    });
    await expect(coordinator.process(job, generator)).resolves.toBe("skipped");
    expect(repository.successes).toHaveLength(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects an invalid generator output and routes it through retry policy", async () => {
    const repository = new FakeRepository();
    const { coordinator, queue } = makeCoordinator(repository);
    await expect(coordinator.process(job, async () => ({ outputRef: "" }))).resolves.toBe("retryable");
    expect(repository.failures[0].error).toContain("invalid output reference");
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("keeps the default retry policy bounded", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });
});
