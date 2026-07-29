jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }));
});
jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation((name) => ({ name })),
    Worker: jest.fn(),
    QueueEvents: jest.fn(),
  };
});

import {
  redisConnection,
  webhookQueue,
  webhookQueueName,
  backupVerificationQueue,
  backupVerificationQueueName,
  reconciliationQueue,
  reconciliationQueueName,
  marketResolutionQueue,
  marketResolutionQueueName,
} from "../src/queue";

describe("Queue Setup", () => {
  it("exports a valid redis connection", () => {
    expect(redisConnection).toBeDefined();
  });

  it("exports all required queues", () => {
    expect(webhookQueue).toBeDefined();
    expect(webhookQueue.name).toBe(webhookQueueName);

    expect(backupVerificationQueue).toBeDefined();
    expect(backupVerificationQueue.name).toBe(backupVerificationQueueName);

    expect(reconciliationQueue).toBeDefined();
    expect(reconciliationQueue.name).toBe(reconciliationQueueName);

    expect(marketResolutionQueue).toBeDefined();
    expect(marketResolutionQueue.name).toBe(marketResolutionQueueName);
  });
});
