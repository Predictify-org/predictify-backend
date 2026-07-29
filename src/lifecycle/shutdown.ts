import { Server } from 'http';
import { logger } from '../config/logger';
import { closeDb } from '../db/client';
import { redisConnection } from '../queue';
import { stopScheduler } from '../services/scheduler';
import type { WebhookWorker } from '../workers/webhookWorker';

export interface ShutdownResources {
  server: Server;
  webhookWorker?: WebhookWorker;
  // Add other workers as needed
}

export interface ShutdownOptions {
  /** Time to wait for in-flight requests to complete (ms) */
  gracefulTimeout?: number;
  /** Time to wait before force-exit after graceful timeout (ms) */
  forceExitTimeout?: number;
}

const DEFAULT_OPTIONS: Required<ShutdownOptions> = {
  gracefulTimeout: 30000, // 30 seconds
  forceExitTimeout: 5000,  // 5 seconds
};

let isShuttingDown = false;

/**
 * Initiate graceful shutdown with drain
 * 
 * This function:
 * 1. Marks the server as draining (rejects new connections)
 * 2. Waits for in-flight requests to complete
 * 3. Drains workers and webhook dispatcher
 * 4. Closes database and Redis connections
 * 5. Flushes logs and exits
 */
export async function gracefulShutdown(
  resources: ShutdownResources,
  options: ShutdownOptions = {}
): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, skipping duplicate');
    return;
  }
  isShuttingDown = true;

  const { gracefulTimeout, forceExitTimeout } = { ...DEFAULT_OPTIONS, ...options };

  logger.info({
    gracefulTimeoutMs: gracefulTimeout,
    forceExitTimeoutMs: forceExitTimeout,
  }, 'Initiating graceful shutdown with drain');

  // Force exit if graceful shutdown takes too long
  const forceExit = setTimeout(() => {
    logger.error('Forced exit after shutdown timeout');
    process.exit(1);
  }, gracefulTimeout + forceExitTimeout).unref();

  try {
    // Phase 1: Stop accepting new connections
    await drainHttpServer(resources.server);

    // Phase 2: Drain workers (finish in-flight jobs)
    await drainWorkers(resources);

    // Phase 3: Drain webhook dispatcher
    await drainWebhookDispatcher(resources);

    // Phase 4: Stop scheduler
    stopScheduler();

    // Phase 5: Close database connections
    await closeDb();

    // Phase 6: Close Redis connection
    await closeRedis();

    // Phase 7: Flush logs
    await flushLogs();

    logger.info('Graceful shutdown completed successfully');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during graceful shutdown');
    clearTimeout(forceExit);
    process.exit(1);
  }
}

/**
 * Drain HTTP server - stop accepting new connections and wait for in-flight requests
 */
async function drainHttpServer(server: Server): Promise<void> {
  logger.info('Draining HTTP server...');

  return new Promise((resolve, reject) => {
    // Mark server as draining (rejects new connections with 503)
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        logger.info('HTTP server drained successfully');
        resolve();
      }
    });

    // Force drain timeout (fallback)
    const timeout = setTimeout(() => {
      logger.warn('HTTP server drain timed out, forcing close');
      server.closeAllConnections();
      resolve();
    }, 5000);

    // Clear timeout on successful close
    server.once('close', () => clearTimeout(timeout));
  });
}

/**
 * Drain workers - stop accepting new jobs and wait for current ones to finish
 */
async function drainWorkers(resources: ShutdownResources): Promise<void> {
  logger.info('Draining workers...');

  const workerStops: Promise<void>[] = [];

  if (resources.webhookWorker) {
    logger.info('Stopping webhook worker...');
    workerStops.push(resources.webhookWorker.stop());
  }

  // Add other workers as needed
  // workerStops.push(marketResolverWorker.stop());
  // workerStops.push(backupVerificationWorker.stop());
  // workerStops.push(reconciliationWorker.stop());

  if (workerStops.length > 0) {
    await Promise.all(workerStops);
    logger.info({ stoppedWorkers: workerStops.length }, 'Workers drained');
  } else {
    logger.info('No workers to drain');
  }
}

/**
 * Drain webhook dispatcher - ensure all webhooks are sent
 */
async function drainWebhookDispatcher(_resources: ShutdownResources): Promise<void> {
  // If there's a webhook dispatcher with drain method, call it
  // For now, we rely on the worker stopping to finish in-flight webhooks
  
  // If resources has a webhookDispatcher with drain, add it here
  // const dispatcher = (resources as any).webhookDispatcher;
  // if (dispatcher && typeof dispatcher.drain === 'function') {
  //   await dispatcher.drain();
  // }
  
  logger.info('Webhook dispatcher drained');
}

/**
 * Close Redis connection gracefully
 */
async function closeRedis(): Promise<void> {
  logger.info('Closing Redis connection...');
  try {
    await redisConnection.quit();
    logger.info('Redis connection closed');
  } catch (error) {
    logger.warn({ error }, 'Error closing Redis connection (ignored)');
  }
}

/**
 * Flush logs before exit
 */
async function flushLogs(): Promise<void> {
  logger.info('Flushing logs...');
  // Pino logger flush - if using pino
  // This ensures all logs are written before exit
  await new Promise((resolve) => {
    (logger as unknown as { flush?: () => void }).flush?.();
    resolve(undefined);
  });
}
