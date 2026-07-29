import { env } from "../config/env";
import { logger } from "../config/logger";
import { reconciliationQueue } from "../queue";

/**
 * Simple cron-like scheduler for running periodic tasks
 * Parses cron expressions and schedules tasks accordingly
 */
class Scheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Parse a cron expression (simplified - only supports 5-field format: minute hour day month weekday)
   * Returns a function that checks if current time matches the cron schedule
   */
  private parseCron(cronExpression: string): () => boolean {
    const parts = cronExpression.split(" ");
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: ${cronExpression}. Expected 5 fields.`);
    }

    const [minute, hour, day, month, weekday] = parts;

    return () => {
      const now = new Date();
      const currentMinute = now.getMinutes();
      const currentHour = now.getHours();
      const currentDay = now.getDate();
      const currentMonth = now.getMonth() + 1; // 1-12
      const currentWeekday = now.getDay(); // 0-6 (Sunday-Saturday)

      const matchesMinute = this.matchField(minute, currentMinute);
      const matchesHour = this.matchField(hour, currentHour);
      const matchesDay = this.matchField(day, currentDay);
      const matchesMonth = this.matchField(month, currentMonth);
      const matchesWeekday = this.matchField(weekday, currentWeekday);

      return matchesMinute && matchesHour && matchesDay && matchesMonth && matchesWeekday;
    };
  }

  /**
   * Check if a value matches a cron field (supports * and numbers)
   */
  private matchField(field: string, value: number): boolean {
    if (field === "*") return true;
    return field === value.toString();
  }

  /**
   * Schedule a task to run at a specific cron expression
   * Checks every minute if the current time matches the schedule
   */
  schedule(name: string, cronExpression: string, task: () => Promise<void>): void {
    if (this.intervals.has(name)) {
      logger.warn({ name }, "Task already scheduled, skipping");
      return;
    }

    const shouldRun = this.parseCron(cronExpression);

    const interval = setInterval(async () => {
      if (shouldRun()) {
        logger.info({ name, cron: cronExpression }, "Running scheduled task");
        try {
          await task();
        } catch (error) {
          logger.error({ error, name }, "Scheduled task failed");
        }
      }
    }, 60 * 1000); // Check every minute

    this.intervals.set(name, interval);
    logger.info({ name, cron: cronExpression }, "Task scheduled");
  }

  /**
   * Stop a scheduled task
   */
  unschedule(name: string): void {
    const interval = this.intervals.get(name);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(name);
      logger.info({ name }, "Task unscheduled");
    }
  }

  /**
   * Stop all scheduled tasks
   */
  stopAll(): void {
    this.intervals.forEach((interval, name) => {
      clearInterval(interval);
      logger.info({ name }, "Task stopped");
    });
    this.intervals.clear();
  }
}

// Global scheduler instance
const scheduler = new Scheduler();

/**
 * Initialize scheduled tasks based on environment configuration
 */
export function initializeScheduler(): void {
  if (!env.RECONCILIATION_ENABLED) {
    logger.info("Reconciliation scheduler disabled");
    return;
  }

  // Schedule nightly reconciliation (default: 2 AM daily)
  scheduler.schedule(
    "reconciliation",
    env.RECONCILIATION_SCHEDULE,
    async () => {
      logger.info("Scheduling global reconciliation job via BullMQ");
      await reconciliationQueue.add("reconciliation-job", { type: "global" });
    }
  );

  logger.info("Scheduler initialized");
}

/**
 * Stop all scheduled tasks (useful for testing or graceful shutdown)
 */
export function stopScheduler(): void {
  scheduler.stopAll();
}

export { scheduler };
