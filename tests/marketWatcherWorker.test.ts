jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: unknown) => ({
    processor,
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/queue", () => ({
  redisConnection: {},
  marketWatcherQueueName: "market-watcher-jobs",
}));

import { Worker } from "bullmq";
import { MarketWatcherWorker } from "../src/workers/marketWatcherWorker";
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
