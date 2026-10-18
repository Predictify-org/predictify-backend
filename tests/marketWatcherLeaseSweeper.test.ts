import {
  MarketWatcherLeaseSweeper,
  SWEEPER_LOCK_KEY,
  createRedisSweeperLock,
  type SweeperLock,
} from "../src/jobs/marketWatcherLeaseSweeper";
import type { MarketWatcherJobRepo } from "../src/services/marketWatcherJobService";
import type { MarketWatcherJob } from "../src/db/schema";

const NOW = new Date("2026-08-29T10:00:00.000Z");

function makeJob(overrides: Partial<MarketWatcherJob> = {}): MarketWatcherJob {
  return {
    id: "job-1",
    marketId: "mkt-1",
    jobKey: "mkt-1:market.resolved:evt-1",
    eventType: "market.resolved",
    status: "retryable",
    attempt: 1,
    leaseToken: null,
    leaseUntil: null,
    startedAt: null,
    completedAt: null,
    nextAttemptAt: NOW,
    watchersNotified: 0,
    payload: { a: 1 },
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRepo(recovered: MarketWatcherJob[] = [], due: MarketWatcherJob[] = []) {
  return {
    recoverExpiredLeases: jest.fn().mockResolvedValue(recovered),
    listDueRetryable: jest.fn().mockResolvedValue(due),
  } as unknown as MarketWatcherJobRepo & {
    recoverExpiredLeases: jest.Mock;
    listDueRetryable: jest.Mock;
  };
}

function makeQueue(states: Record<string, string> = {}) {
  return {
    add: jest.fn().mockResolvedValue({}),
    getJob: jest.fn(async (id: string) =>
      states[id] ? { getState: async () => states[id] } : null,
    ),
  };
}

describe("MarketWatcherLeaseSweeper", () => {
  it("recovers expired leases and re-enqueues with a :recover:<attempt> id", async () => {
    const job = makeJob({ attempt: 2 });
    const repo = makeRepo([job], [job]);
    const queue = makeQueue({ [job.jobKey]: "completed" });
    const sweeper = new MarketWatcherLeaseSweeper(repo, {
      queue,
      lock: { acquire: async () => true },
      intervalMs: 1000,
      now: () => NOW,
    });

    const res = await sweeper.sweepOnce();

    expect(res).toEqual({ locked: true, recovered: 1, enqueued: 1 });
    expect(repo.recoverExpiredLeases).toHaveBeenCalledWith(NOW, 3);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "notify-watchers",
      expect.objectContaining({ jobId: "job-1", eventRef: "evt-1", payload: { a: 1 } }),
      expect.objectContaining({ jobId: `${job.jobKey}:recover:2` }),
    );
  });

  it("re-enqueues due retryable jobs but skips ones with a live queue job", async () => {
    const live = makeJob({ id: "live", jobKey: "k-live", marketId: "m", eventType: "e" });
    const dead = makeJob({ id: "dead", jobKey: "k-dead", marketId: "m", eventType: "e" });
    const repo = makeRepo([], [live, dead]);
    const queue = makeQueue({ "k-live:retry:1": "delayed" });
    const sweeper = new MarketWatcherLeaseSweeper(repo, {
      queue,
      lock: { acquire: async () => true },
      intervalMs: 1000,
      now: () => NOW,
    });

    const res = await sweeper.sweepOnce();

    expect(res.enqueued).toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      "notify-watchers",
      expect.objectContaining({ jobId: "dead", eventRef: "k-dead" }),
      expect.objectContaining({ jobId: "k-dead:recover:1" }),
    );
  });

  it("does not enqueue jobs that became failed on recovery", async () => {
    const failed = makeJob({ status: "failed", attempt: 3 });
    const repo = makeRepo([failed], []);
    const queue = makeQueue();
    const sweeper = new MarketWatcherLeaseSweeper(repo, {
      queue,
      lock: { acquire: async () => true },
      intervalMs: 1000,
      now: () => NOW,
    });

    expect(await sweeper.sweepOnce()).toEqual({ locked: true, recovered: 1, enqueued: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("lets only one of two replicas sweep per tick", async () => {
    const held = new Set<string>();
    const lock: SweeperLock = {
      async acquire(key) {
        if (held.has(key)) return false;
        held.add(key);
        return true;
      },
    };
    const job = makeJob();
    const repoA = makeRepo([job], []);
    const repoB = makeRepo([job], []);
    const queue = makeQueue();
    const mk = (repo: MarketWatcherJobRepo) =>
      new MarketWatcherLeaseSweeper(repo, { queue, lock, intervalMs: 1000, now: () => NOW });

    const [a, b] = await Promise.all([mk(repoA).sweepOnce(), mk(repoB).sweepOnce()]);

    expect([a.locked, b.locked].sort()).toEqual([false, true]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(repoA.recoverExpiredLeases.mock.calls.length + repoB.recoverExpiredLeases.mock.calls.length).toBe(1);
  });

  it("runs on a timer until stopped", async () => {
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const sweeper = new MarketWatcherLeaseSweeper(repo, {
        queue: makeQueue(),
        lock: { acquire: async () => true },
        intervalMs: 1000,
      });
      sweeper.start();
      sweeper.start();
      await jest.advanceTimersByTimeAsync(2100);
      expect(repo.recoverExpiredLeases.mock.calls.length).toBe(2);
      await sweeper.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(repo.recoverExpiredLeases.mock.calls.length).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps ticking when a sweep throws", async () => {
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      repo.recoverExpiredLeases.mockRejectedValueOnce(new Error("db down"));
      const sweeper = new MarketWatcherLeaseSweeper(repo, {
        queue: makeQueue(),
        lock: { acquire: async () => true },
        intervalMs: 1000,
      });
      sweeper.start();
      await jest.advanceTimersByTimeAsync(2100);
      expect(repo.recoverExpiredLeases.mock.calls.length).toBe(2);
      await sweeper.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("createRedisSweeperLock", () => {
  it("uses SET NX PX and reports acquisition", async () => {
    const set = jest.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const lock = createRedisSweeperLock({ set } as never);

    expect(await lock.acquire(SWEEPER_LOCK_KEY, 500)).toBe(true);
    expect(await lock.acquire(SWEEPER_LOCK_KEY, 500)).toBe(false);
    expect(set).toHaveBeenCalledWith(SWEEPER_LOCK_KEY, expect.any(String), "PX", 500, "NX");
  });
});
