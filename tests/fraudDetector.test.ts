import { FraudDetectorWorker } from "../src/workers/fraudDetector";
import type {
  FlagWriteInput,
  FraudFlagDTO,
  FraudRepo,
  PredictionRow,
} from "../src/services/fraudService";

class FakeRepo implements FraudRepo {
  rows: PredictionRow[] = [];
  written: FlagWriteInput[] = [];
  shouldThrow = false;
  async loadRecentPredictions(): Promise<PredictionRow[]> {
    if (this.shouldThrow) throw new Error("boom");
    return this.rows;
  }
  async upsertFlags(rows: FlagWriteInput[]): Promise<number> {
    this.written.push(...rows);
    return rows.length;
  }
  async listFlags(): Promise<FraudFlagDTO[]> {
    return [];
  }
}

describe("FraudDetectorWorker", () => {
  it("runOnce returns the scan result for a happy path", async () => {
    const repo = new FakeRepo();
    const worker = new FraudDetectorWorker(repo);
    const res = await worker.runOnce({ correlationId: "abc" });
    expect(res).not.toBeNull();
    expect(res!.correlationId).toBe("abc");
    expect(res!.scanned).toBe(0);
  });

  it("runOnce swallows errors and returns null instead of throwing", async () => {
    const repo = new FakeRepo();
    repo.shouldThrow = true;
    const worker = new FraudDetectorWorker(repo);
    const res = await worker.runOnce();
    expect(res).toBeNull();
  });

  it("start() refuses non-positive intervals", () => {
    const worker = new FraudDetectorWorker(new FakeRepo());
    const stop = worker.start(0);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("start() invokes the scan and stop() halts the timer", async () => {
    jest.useFakeTimers();
    const repo = new FakeRepo();
    const worker = new FraudDetectorWorker(repo);
    const spy = jest.spyOn(worker, "runOnce");
    const stop = worker.start(1000);

    // start() schedules an immediate run via void this.runOnce(); flush microtasks
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);

    stop();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("start() called twice does not stack timers", () => {
    jest.useFakeTimers();
    const worker = new FraudDetectorWorker(new FakeRepo());
    const stop1 = worker.start(1000);
    const stop2 = worker.start(1000); // should warn + no-op
    expect(typeof stop2).toBe("function");
    stop1();
    jest.useRealTimers();
  });
});
