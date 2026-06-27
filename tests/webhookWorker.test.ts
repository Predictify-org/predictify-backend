jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }));
});
jest.mock("bullmq", () => {
  return {
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn(),
    })),
    Queue: jest.fn(),
  };
});
jest.mock("../src/services/webhookDispatcher", () => ({
  attemptDelivery: jest.fn(),
  getOverdueDeliveries: jest.fn(),
}));
jest.mock("../src/queue", () => ({
  webhookQueue: { add: jest.fn() },
  redisConnection: {},
  webhookQueueName: "webhook-deliveries",
}));

import { WebhookWorker } from "../src/workers/webhookWorker";
import { Worker } from "bullmq";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

describe("WebhookWorker", () => {
  let db: any;
  let worker: WebhookWorker;

  beforeEach(() => {
    db = {}; // mock db
    worker = new WebhookWorker(db as NodePgDatabase, { concurrency: 5 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("initializes and starts the worker", () => {
    worker.start();
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(Worker).toHaveBeenCalledWith("webhook-deliveries", expect.any(Function), expect.objectContaining({ concurrency: 5 }));
  });

  it("can stop the worker", async () => {
    worker.start();
    await worker.stop();
    const workerInstance = (Worker as unknown as jest.Mock).mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });
});
