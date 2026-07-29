import { SignupAnomalyDetectorWorker } from "../src/workers/signupAnomalyDetector";
import type {
  SignupAnomalyRepo,
  SignupBucket,
} from "../src/services/anomalyDetector";

class FakeRepo implements SignupAnomalyRepo {
  buckets: SignupBucket[] = [];
  shouldThrow = false;
  calls = 0;

  async loadSignupBuckets(): Promise<SignupBucket[]> {
    this.calls += 1;
    if (this.shouldThrow) throw new Error("boom");
    return this.buckets;
  }
}

describe("SignupAnomalyDetectorWorker", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("runOnce returns the report for a happy path", async () => {
    const worker = new SignupAnomalyDetectorWorker(new FakeRepo());
    const report = await worker.runOnce({ correlationId: "abc" });
    expect(report).not.toBeNull();
    expect(report!.correlationId).toBe("abc");
    expect(report!.anomalies).toEqual([]);
  });

  it("runOnce generates a correlation id when none is supplied", async () => {
    const worker = new SignupAnomalyDetectorWorker(new FakeRepo());
    const report = await worker.runOnce();
    expect(report!.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("runOnce swallows errors and returns null instead of throwing", async () => {
    const repo = new FakeRepo();
    repo.shouldThrow = true;
    const worker = new SignupAnomalyDetectorWorker(repo);
    await expect(worker.runOnce()).resolves.toBeNull();
  });

  it("runOnce returns null when options fail validation", async () => {
    const worker = new SignupAnomalyDetectorWorker(new FakeRepo());
    await expect(worker.runOnce({ minCount: -1 })).resolves.toBeNull();
  });

  it("start() refuses non-positive intervals", () => {
    const repo = new FakeRepo();
    const worker = new SignupAnomalyDetectorWorker(repo);
    const stop = worker.start(0);
    expect(typeof stop).toBe("function");
    expect(repo.calls).toBe(0);
    stop();
  });

  it("start() refuses a non-finite interval", () => {
    const repo = new FakeRepo();
    const worker = new SignupAnomalyDetectorWorker(repo);
    worker.start(Number.POSITIVE_INFINITY)();
    expect(repo.calls).toBe(0);
  });

  it("start() runs immediately, then on the interval; stop() halts the timer", async () => {
    jest.useFakeTimers();
    const worker = new SignupAnomalyDetectorWorker(new FakeRepo());
    const spy = jest.spyOn(worker, "runOnce");

    const stop = worker.start(1000);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2000);
    expect(spy).toHaveBeenCalledTimes(3);

    stop();
    jest.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("start() is idempotent while already running", async () => {
    jest.useFakeTimers();
    const worker = new SignupAnomalyDetectorWorker(new FakeRepo());
    const spy = jest.spyOn(worker, "runOnce");

    worker.start(1000);
    await Promise.resolve();
    worker.start(1000); // ignored
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it("stop() is safe to call when never started", () => {
    expect(() => new SignupAnomalyDetectorWorker(new FakeRepo()).stop()).not.toThrow();
  });
});
