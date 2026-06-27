import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "../config/logger";

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
  logger.error({ err }, "Redis connection error");
});

export const webhookQueueName = "webhook-deliveries";

export const webhookQueue = new Queue(webhookQueueName, {
  // @ts-expect-error IORedis types conflict with BullMQ
  connection: redisConnection,
});

export { Queue, Worker, QueueEvents };
