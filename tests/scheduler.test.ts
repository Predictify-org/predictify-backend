import { register } from "../src/metrics/registry";
import {
  Scheduler,
  parseCron,
  matchesCron,
  nextCronSlot,
  formatSlotIsoMinute,
  buildReconciliationJobId,
  enqueueReconciliationJob,
  initializeScheduler,
  stopScheduler,
  scheduler,
  type ReconciliationQueueLike,
} from "../src/services/scheduler";

interface PendingTimer {
  id: number;
  runAtMs: number;
  callback: () => void;
  cleared: boolean;
}

class DeterministicClock {
  private currentMs: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, PendingTimer>();

  constructor(initialIso: string) {
    this.currentMs = Date.parse(initialIso);
  }

  now = (): Date => new Date(this.currentMs);

  setTimeout = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextTimerId++;
    const safeDelay = Math.max(0, delayMs);
    this.timers.set(id, {
      id,
      runAtMs: this.currentMs + safeDelay,
      callback,
      cleared: false,
    });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };

  clearTimeout = (handle: ReturnType<typeof globalThis.setTimeout>): void => {
    const id = handle as unknown as number;
    const timer = this.timers.get(id);
    if (timer) {
      timer.cleared = true;
      this.timers.delete(id);
    }
  };

  get activeTimerCount(): number {
    return this.timers.size;
  }

  async advanceTo(targetIso: string): Promise<void> {
    const targetMs = Date.parse(targetIso);
    while (true) {
      let earliest: PendingTimer | undefined;
      for (const timer of this.timers.values()) {
        if (!timer.cleared && timer.runAtMs <= targetMs) {
          if (!earliest || timer.runAtMs < earliest.runAtMs) {
            earliest = timer;
          }
        }
      }
      if (!earliest) break;
      this.timers.delete(earliest.id);
      this.currentMs = earliest.runAtMs;
      earliest.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.currentMs = targetMs;
  }

  async advanceWithEventLoopDelay(
    fireAtIso: string,
    actualCallbackClockIso: string,
  ): Promise<void> {
    const fireAtMs = Date.parse(fireAtIso);
    const delayedMs = Date.parse(actualCallbackClockIso);
    const due: PendingTimer[] = [];
    for (const timer of this.timers.values()) {
      if (!timer.cleared && timer.runAtMs <= fireAtMs) {
        due.push(timer);
      }
    }
    due.sort((a, b) => a.runAtMs - b.runAtMs);
    this.currentMs = delayedMs;
    for (const timer of due) {
      this.timers.delete(timer.id);
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

class FakeBullQueue implements ReconciliationQueueLike {
  readonly jobs = new Map<
    string,
    { name: string; data: { type: "global" }; opts?: { jobId?: string } }
  >();

  readonly add = jest.fn(
    async (
      name: string,
      data: { type: "global" },
      opts?: { jobId?: string },
    ) => {
      const id = opts?.jobId ?? `auto-${this.jobs.size + 1}`;
      if (this.jobs.has(id)) {
        return { id, name, data, opts, deduped: true };
      }
      const created = { id, name, data, opts, deduped: false };
      this.jobs.set(id, created);
      return created;
    },
  );

  readonly getJob = jest.fn(async (jobId: string) => {
    return this.jobs.get(jobId) ?? null;
  });
}

describe("Scheduler & Cron Parser (Issue #982)", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    stopScheduler();
    process.env.TZ = originalTz;
  });

  it("Row 1: */15 * * * * at 10:14:59Z, then 10:15:00Z fires exactly once at 10:15Z", async () => {
    const clock = new DeterministicClock("2026-10-18T10:14:59.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const firedAt: string[] = [];
    sched.schedule("quarter-hour", "*/15 * * * *", async (slot) => {
      firedAt.push(slot.toISOString());
    });

    expect(firedAt).toEqual([]);

    await clock.advanceTo("2026-10-18T10:15:00.000Z");
    expect(firedAt).toEqual(["2026-10-18T10:15:00.000Z"]);

    // Advancing within the same 10:15 minute does not fire a second time
    await clock.advanceTo("2026-10-18T10:29:59.000Z");
    expect(firedAt).toEqual(["2026-10-18T10:15:00.000Z"]);

    sched.stopAll();
  });

  it("Row 2: 0 2 * * 1-5 on a Saturday does not fire on weekend; fires Monday 02:00Z", async () => {
    // 2026-10-17 is Saturday (UTC day 6)
    const clock = new DeterministicClock("2026-10-17T01:00:00.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const firedAt: string[] = [];
    sched.schedule("weekday-2am", "0 2 * * 1-5", async (slot) => {
      firedAt.push(slot.toISOString());
    });

    // Saturday 02:00Z and Sunday 02:00Z must not fire
    await clock.advanceTo("2026-10-17T12:00:00.000Z");
    expect(firedAt).toEqual([]);

    await clock.advanceTo("2026-10-18T23:59:59.000Z");
    expect(firedAt).toEqual([]);

    // Monday 2026-10-19T02:00:00Z fires
    await clock.advanceTo("2026-10-19T02:00:00.000Z");
    expect(firedAt).toEqual(["2026-10-19T02:00:00.000Z"]);

    sched.stopAll();
  });

  it("Row 3: 0 0,12 * * * fires at 00:00Z and 12:00Z only", async () => {
    const clock = new DeterministicClock("2026-10-18T00:00:00.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const firedAt: string[] = [];
    sched.schedule("twice-daily", "0 0,12 * * *", async (slot) => {
      firedAt.push(slot.toISOString());
    });

    await clock.advanceTo("2026-10-19T00:00:00.000Z");
    expect(firedAt).toEqual([
      "2026-10-18T12:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
    ]);

    sched.stopAll();
  });

  it("Row 4: invalid cron expressions throw on parseCron and schedule()", () => {
    const clock = new DeterministicClock("2026-10-18T00:00:00.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const invalidExpressions = [
      "61 * * * *",
      "* * *",
      "*/0 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 0 *",
      "* * * 13 *",
      "* * * * 7",
      "10-5 * * * *",
      "10/2 * * * *",
      "1, * * * *",
      "0 0 31 2 *",
      "",
    ];

    for (const expr of invalidExpressions) {
      expect(() => parseCron(expr)).toThrow();
      expect(() =>
        sched.schedule(`bad-${expr}`, expr, async () => undefined),
      ).toThrow();
    }
    expect(clock.activeTimerCount).toBe(0);
  });

  it("Row 5: evaluates fire times in UTC even when host TZ is America/New_York", async () => {
    process.env.TZ = "America/New_York";
    const clock = new DeterministicClock("2026-10-18T01:59:30.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const firedAt: string[] = [];
    sched.schedule("utc-2am", "0 2 * * *", async (slot) => {
      firedAt.push(slot.toISOString());
    });

    await clock.advanceTo("2026-10-18T02:00:00.000Z");
    expect(firedAt).toEqual(["2026-10-18T02:00:00.000Z"]);

    sched.stopAll();
  });

  it("Row 6: two scheduler instances (two replicas) enqueue the same deterministic jobId and the queue keeps one job", async () => {
    const clockA = new DeterministicClock("2026-10-18T01:59:50.000Z");
    const clockB = new DeterministicClock("2026-10-18T01:59:55.000Z");
    const sharedQueue = new FakeBullQueue();

    const replicaA = new Scheduler({
      now: clockA.now,
      setTimeout: clockA.setTimeout,
      clearTimeout: clockA.clearTimeout,
    });
    const replicaB = new Scheduler({
      now: clockB.now,
      setTimeout: clockB.setTimeout,
      clearTimeout: clockB.clearTimeout,
    });

    replicaA.schedule("reconciliation", "0 2 * * *", (slot) =>
      enqueueReconciliationJob(slot, sharedQueue),
    );
    replicaB.schedule("reconciliation", "0 2 * * *", (slot) =>
      enqueueReconciliationJob(slot, sharedQueue),
    );

    await clockA.advanceTo("2026-10-18T02:00:00.000Z");
    await clockB.advanceTo("2026-10-18T02:00:00.000Z");

    const expectedJobId = "reconciliation:2026-10-18T02:00Z";
    expect(
      buildReconciliationJobId(new Date("2026-10-18T02:00:00.000Z")),
    ).toBe(expectedJobId);
    expect(sharedQueue.add).toHaveBeenCalledTimes(2);
    expect(sharedQueue.add).toHaveBeenNthCalledWith(
      1,
      "reconciliation-job",
      { type: "global" },
      { jobId: expectedJobId },
    );
    expect(sharedQueue.add).toHaveBeenNthCalledWith(
      2,
      "reconciliation-job",
      { type: "global" },
      { jobId: expectedJobId },
    );
    expect(sharedQueue.jobs.size).toBe(1);

    replicaA.stopAll();
    replicaB.stopAll();
  });

  it("Row 7: event-loop delay of 70 s around a slot runs the task once for that slot, not twice", async () => {
    const clock = new DeterministicClock("2026-10-18T10:14:50.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const slotsRun: string[] = [];
    sched.schedule("delayed-task", "*/15 * * * *", async (slot) => {
      slotsRun.push(formatSlotIsoMinute(slot));
    });

    // Timer was scheduled for 10:15:00Z, but event loop was stalled 70s until 10:16:10Z
    await clock.advanceWithEventLoopDelay(
      "2026-10-18T10:15:00.000Z",
      "2026-10-18T10:16:10.000Z",
    );
    expect(slotsRun).toEqual(["2026-10-18T10:15Z"]);

    // Attempting to execute the same slot again via the in-process guard is a no-op
    const ranAgain = await sched.runSlotIfNotExecuted(
      "delayed-task",
      new Date("2026-10-18T10:15:00.000Z"),
    );
    expect(ranAgain).toBe(false);
    expect(slotsRun).toEqual(["2026-10-18T10:15Z"]);

    // Next slot fires at 10:30Z
    await clock.advanceTo("2026-10-18T10:30:00.000Z");
    expect(slotsRun).toEqual(["2026-10-18T10:15Z", "2026-10-18T10:30Z"]);

    sched.stopAll();
  });

  it("Row 8 & initializeScheduler: respects RECONCILIATION_ENABLED=false and schedules when enabled", async () => {
    const clock = new DeterministicClock("2026-10-18T01:59:00.000Z");
    const fakeQueue = new FakeBullQueue();
    const targetScheduler = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    initializeScheduler({
      enabled: false,
      schedule: "0 2 * * *",
      schedulerInstance: targetScheduler,
      queue: fakeQueue,
    });
    expect(clock.activeTimerCount).toBe(0);

    initializeScheduler({
      enabled: true,
      schedule: "0 2 * * *",
      schedulerInstance: targetScheduler,
      queue: fakeQueue,
    });
    expect(clock.activeTimerCount).toBe(1);

    await clock.advanceTo("2026-10-18T02:00:00.000Z");
    expect(fakeQueue.jobs.size).toBe(1);
    expect(fakeQueue.jobs.has("reconciliation:2026-10-18T02:00Z")).toBe(true);

    targetScheduler.stopAll();
  });

  it("Row 10: stopScheduler() and unschedule() clear all pending timers and handle errors/metrics", async () => {
    const clock = new DeterministicClock("2026-10-18T10:00:00.000Z");
    const sched = new Scheduler({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const runs: number[] = [];
    sched.schedule("step-range", "10-40/15 * * * *", async (slot) => {
      runs.push(slot.getUTCMinutes());
    });
    // Duplicate schedule call is ignored
    sched.schedule("step-range", "10-40/15 * * * *", async () => undefined);

    sched.schedule("failing-task", "*/10 * * * *", async () => {
      throw new Error("boom");
    });

    expect(clock.activeTimerCount).toBe(2);

    await clock.advanceTo("2026-10-18T10:10:00.000Z");
    expect(runs).toEqual([10]);

    sched.unschedule("step-range");
    sched.unschedule("non-existent");
    expect(clock.activeTimerCount).toBe(1);

    sched.stopAll();
    expect(clock.activeTimerCount).toBe(0);

    // Global scheduler stopScheduler() also leaves zero active timers
    expect(scheduler).toBeInstanceOf(Scheduler);
    initializeScheduler();
    stopScheduler();

    // Exercise matchesCron (string + ParsedCron), leap-day month-jumping, bare queue without getJob, and non-Error throw
    const leapCron = parseCron("0 0 29 2 *");
    expect(matchesCron("0 0 29 2 *", new Date("2028-02-29T00:00:00.000Z"))).toBe(true);
    expect(matchesCron(leapCron, new Date("2026-02-28T00:00:00.000Z"))).toBe(false);
    expect(nextCronSlot("0 0 29 2 *", new Date("2026-10-18T00:00:00.000Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(() => parseCron("0/2/3 * * * *")).toThrow();
    expect(() => parseCron("1-2-3 * * * *")).toThrow();
    expect(() => parseCron("abc * * * *")).toThrow();

    const bareQueue: ReconciliationQueueLike = {
      add: jest.fn().mockResolvedValue({ id: "reconciliation:2026-10-18T02:00Z" }),
    };
    const slotDate = new Date("2026-10-18T02:00:00.000Z");
    expect(buildReconciliationJobId(slotDate).split(":")).toHaveLength(3);
    expect(await enqueueReconciliationJob(slotDate, bareQueue)).toBe("enqueued");
    expect(await enqueueReconciliationJob(slotDate, bareQueue)).toBe("deduped");

    // Exercise bounded slot eviction (> 1024 unique slots)
    for (let i = 0; i < 1030; i++) {
      await enqueueReconciliationJob(new Date(slotDate.getTime() + (i + 1) * 60_000), bareQueue);
    }

    expect(await sched.runSlotIfNotExecuted("missing-task", slotDate)).toBe(false);
    sched.schedule("string-throw", "* * * * *", async () => {
      throw "non-error-failure";
    });
    await sched.runSlotIfNotExecuted("string-throw", slotDate);
    sched.stopAll();

    // Monthly schedule > 24.85 days (MAX_TIMEOUT_MS = 2^31 - 1) hops safely without premature firing
    const monthlyClock = new DeterministicClock("2026-01-01T02:01:00.000Z");
    const monthlySched = new Scheduler({
      now: monthlyClock.now,
      setTimeout: monthlyClock.setTimeout,
      clearTimeout: monthlyClock.clearTimeout,
    });
    const monthlyFired: string[] = [];
    monthlySched.schedule("monthly", "0 2 1 * *", async (slot) => {
      monthlyFired.push(slot.toISOString());
    });

    // At +25 days (after first 24.85d hop), task must NOT have fired yet
    await monthlyClock.advanceTo("2026-01-26T12:00:00.000Z");
    expect(monthlyFired).toEqual([]);

    // At 2026-02-01T02:00:00.000Z, task fires once
    await monthlyClock.advanceTo("2026-02-01T02:00:00.000Z");
    expect(monthlyFired).toEqual(["2026-02-01T02:00:00.000Z"]);
    monthlySched.stopAll();

    const metricsText = await register.metrics();
    expect(metricsText).toContain("scheduler_runs_total");
  });
});


