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

import { redisConnection, webhookQueue, webhookQueueName } from "../src/queue";

describe("Queue Setup", () => {
  it("exports a valid redis connection", () => {
    expect(redisConnection).toBeDefined();
  });

  it("exports a valid webhookQueue", () => {
    expect(webhookQueue).toBeDefined();
    expect(webhookQueue.name).toBe(webhookQueueName);
  });
});
