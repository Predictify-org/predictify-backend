jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: unknown) => ({
    processor,
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/queue", () => ({
  redisConnection: {},
  marketWatcherQueue: {},
  marketWatcherQueueName: "market-watcher-jobs",
}));
import { Worker } from "bullmq";
import { MarketWatcherWorker } from "../src/workers/marketWatcherWorker";
import { startMarketWatcher } from "../src/workers/marketWatcher";
import { MarketWatcherJobRepo } from "../src/services/marketWatcherJobService";

describe("MarketWatcherWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts one BullMQ worker and is idempotent", () => {
    const worker = new MarketWatcherWorker({} as MarketWatcherJobRepo);
    worker.start();
    worker.start();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  it("closes the worker during stop and tolerates repeated stop", async () => {
    const worker = new MarketWatcherWorker({} as MarketWatcherJobRepo);
    worker.start();
    await worker.stop();
    await worker.stop();
    const instance = (Worker as unknown as jest.Mock).mock.results.at(-1)?.value;
    expect(instance.close).toHaveBeenCalledTimes(1);
  });
});

describe("startMarketWatcher entrypoint", () => {
  it("starts worker and sweeper, and drains in order on shutdown (idempotent)", async () => {
    const order: string[] = [];
    let finishJob!: () => void;
    const inFlight = new Promise<void>((r) => (finishJob = r));
    const worker = {
      start: jest.fn(() => order.push("worker.start")),
      stop: jest.fn(async () => {
        await inFlight; // worker.close waits for the in-flight job
        order.push("worker.stop");
      }),
    };
    const sweeper = {
      start: jest.fn(() => order.push("sweeper.start")),
      stop: jest.fn(async () => void order.push("sweeper.stop")),
    };
    const cleanup = jest.fn(async () => void order.push("cleanup"));

    const proc = startMarketWatcher(worker, sweeper, cleanup);
    const first = proc.shutdown();
    const second = proc.shutdown();
    order.push("signal-handled");
    finishJob();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "worker.start",
      "sweeper.start",
      "signal-handled",
      "sweeper.stop",
      "worker.stop",
      "cleanup",
    ]);
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });

  it("works with the default no-op cleanup", async () => {
    const worker = { start: jest.fn(), stop: jest.fn().mockResolvedValue(undefined) };
    const sweeper = { start: jest.fn(), stop: jest.fn().mockResolvedValue(undefined) };
    await startMarketWatcher(worker, sweeper).shutdown();
    expect(worker.stop).toHaveBeenCalled();
  });
});
