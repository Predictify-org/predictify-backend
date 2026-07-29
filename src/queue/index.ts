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
export const backupVerificationQueueName = "backup-verification";
export const reconciliationQueueName = "reconciliation";
export const marketResolutionQueueName = "market-resolution";

export const webhookQueue = new Queue(webhookQueueName, {
  //  IORedis types conflict with BullMQ
  connection: redisConnection,
});

export const backupVerificationQueue = new Queue(backupVerificationQueueName, {
  //  IORedis types conflict with BullMQ
  connection: redisConnection,
});

export const reconciliationQueue = new Queue(reconciliationQueueName, {
  //  IORedis types conflict with BullMQ
  connection: redisConnection,
});

export const marketResolutionQueue = new Queue(marketResolutionQueueName, {
  //  IORedis types conflict with BullMQ
  connection: redisConnection,
});

export { Queue, Worker, QueueEvents };
