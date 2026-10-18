import { schedulerRunsTotal } from "../metrics/registry";

export interface ParsedCron {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
}

const MAX_DAYS_BY_MONTH: Readonly<Record<number, number>> = {
  1: 31,
  2: 29,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
};

function parseStrictInt(raw: string, fieldName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid cron ${fieldName} token "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

function parseCronField(field: string, min: number, max: number, fieldName: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) {
      throw new Error(`Invalid empty list element in cron ${fieldName} field "${field}"`);
    }
    const slashParts = part.split("/");
    if (slashParts.length > 2) {
      throw new Error(`Invalid step syntax in cron ${fieldName} field "${part}"`);
    }

    const [rangePart, stepPart] = slashParts;
    let step = 1;
    if (stepPart !== undefined) {
      step = parseStrictInt(stepPart, fieldName);
      if (step < 1 || step > max) {
        throw new Error(`Cron ${fieldName} step ${step} out of bounds (1-${max})`);
      }
    }

    let rangeStart = min;
    let rangeEnd = max;
    if (rangePart === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (rangePart.includes("-")) {
      const dashParts = rangePart.split("-");
      if (dashParts.length !== 2 || !dashParts[0] || !dashParts[1]) {
        throw new Error(`Invalid range "${rangePart}" in cron ${fieldName}`);
      }
      rangeStart = parseStrictInt(dashParts[0], fieldName);
      rangeEnd = parseStrictInt(dashParts[1], fieldName);
      if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
        throw new Error(`Cron ${fieldName} range ${rangeStart}-${rangeEnd} out of bounds (${min}-${max})`);
      }
    } else {
      if (stepPart !== undefined) {
        throw new Error(`Step in cron ${fieldName} requires "*" or a-b range, got "${part}"`);
      }
      const single = parseStrictInt(rangePart, fieldName);
      if (single < min || single > max) {
        throw new Error(`Cron ${fieldName} value ${single} out of bounds (${min}-${max})`);
      }
      rangeStart = single;
      rangeEnd = single;
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      values.add(v);
    }
  }
  return values;
}

/**
 * Parse and validate a 5-field UTC cron expression (`minute hour day month weekday`).
 */
export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Cron expression cannot be empty");
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Expected 5 cron fields (minute hour day month weekday), got ${fields.length}`);
  }

  const [minField, hourField, domField, monthField, dowField] = fields;
  const minutes = parseCronField(minField, 0, 59, "minute");
  const hours = parseCronField(hourField, 0, 23, "hour");
  const daysOfMonth = parseCronField(domField, 1, 31, "day");
  const months = parseCronField(monthField, 1, 12, "month");
  const daysOfWeek = parseCronField(dowField, 0, 6, "weekday");

  if (domField !== "*") {
    for (const day of daysOfMonth) {
      const canOccur = Array.from(months).some((m) => day <= MAX_DAYS_BY_MONTH[m]);
      if (!canOccur) {
        throw new Error(
          `Impossible calendar date in cron expression "${expression}": day ${day} never occurs in months [${Array.from(months).join(",")}]`,
        );
      }
    }
  }

  return { expression: trimmed, minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Evaluate whether a Date matches a parsed 5-field cron expression in UTC.
 */
export function matchesCron(cron: ParsedCron | string, date: Date): boolean {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  return (
    parsed.minutes.has(date.getUTCMinutes()) &&
    parsed.hours.has(date.getUTCHours()) &&
    parsed.daysOfMonth.has(date.getUTCDate()) &&
    parsed.months.has(date.getUTCMonth() + 1) &&
    parsed.daysOfWeek.has(date.getUTCDay())
  );
}

/**
 * Compute the next UTC minute boundary strictly after `fromDate` that matches `cron`.
 */
export function nextCronSlot(cron: ParsedCron | string, fromDate: Date): Date {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const startMs = Math.floor(fromDate.getTime() / 60_000) * 60_000 + 60_000;
  const candidate = new Date(startMs);
  const maxYear = candidate.getUTCFullYear() + 8;

  while (candidate.getUTCFullYear() <= maxYear) {
    if (!parsed.months.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.daysOfMonth.has(candidate.getUTCDate()) || !parsed.daysOfWeek.has(candidate.getUTCDay())) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minutes.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }

  /* istanbul ignore next */
  throw new Error(`No matching UTC cron slot found within 8 years for "${parsed.expression}"`);
}

/**
 * Maximum 32-bit signed integer delay supported by Node.js timers (~24.85 days).
 * Delays exceeding this value are split across intermediate timer hops to prevent
 * `TimeoutOverflowWarning` (which would otherwise clamp the delay to 1 ms).
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;
export const MAX_TRACKED_SLOTS = 1_024;

function addBoundedSlot(set: Set<string>, key: string): void {
  if (set.size >= MAX_TRACKED_SLOTS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
  set.add(key);
}

/**
 * Format a Date to its UTC ISO minute string (`YYYY-MM-DDTHH:mmZ`).
 */
export function formatSlotIsoMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

/**
 * Build the deterministic BullMQ jobId for a reconciliation slot (`reconciliation:<slot ISO minute>`).
 * Uses `YYYY-MM-DDTHH:mmZ` (omitting `:ss`) so the `jobId` contains exactly 3 colon-separated
 * segments, satisfying BullMQ 5.x custom `jobId` validation rules.
 */
export function buildReconciliationJobId(slotDate: Date): string {
  return `reconciliation:${formatSlotIsoMinute(slotDate)}`;
}

export type SchedulerTaskOutcome = "enqueued" | "deduped";
export type ScheduledTaskFn = (
  slotDate: Date,
) => Promise<SchedulerTaskOutcome | void> | SchedulerTaskOutcome | void;

export interface SchedulerLogger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}

export interface ReconciliationQueueLike {
  add(
    name: string,
    data: { type: "global"; marketId?: string },
    opts?: { jobId?: string },
  ): Promise<unknown>;
  getJob?(jobId: string): Promise<unknown>;
}

const seenJobIdsByQueue = new WeakMap<object, Set<string>>();

function getDefaultLogger(): SchedulerLogger {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { logger } = require("../config/logger") as typeof import("../config/logger");
  return logger;
}

/* istanbul ignore next */
function getDefaultReconciliationQueue(): ReconciliationQueueLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { reconciliationQueue } = require("../queue") as typeof import("../queue");
  return reconciliationQueue;
}

function getDefaultEnv(): { RECONCILIATION_ENABLED: boolean; RECONCILIATION_SCHEDULE: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require("../config/env") as typeof import("../config/env");
  return env;
}

/**
 * Enqueue a global reconciliation job for `slotDate` using a deterministic `jobId`
 * so duplicate submissions across replicas are dropped by BullMQ.
 */
export async function enqueueReconciliationJob(
  slotDate: Date,
  queue: ReconciliationQueueLike = getDefaultReconciliationQueue(),
  log: SchedulerLogger = getDefaultLogger(),
): Promise<SchedulerTaskOutcome> {
  const slotIso = formatSlotIsoMinute(slotDate);
  const jobId = buildReconciliationJobId(slotDate);

  const existingInQueue = typeof queue.getJob === "function" ? await queue.getJob(jobId) : null;
  let seenSet = seenJobIdsByQueue.get(queue);
  if (!seenSet) {
    seenSet = new Set<string>();
    seenJobIdsByQueue.set(queue, seenSet);
  }
  const alreadySeen = seenSet.has(jobId);

  await queue.add("reconciliation-job", { type: "global" }, { jobId });
  addBoundedSlot(seenSet, jobId);

  const wasDeduped = Boolean(existingInQueue) || alreadySeen;
  const outcome: SchedulerTaskOutcome = wasDeduped ? "deduped" : "enqueued";
  log.info(
    { task: "reconciliation", jobId, slot: slotIso, outcome },
    wasDeduped
      ? "Reconciliation job deduped for slot"
      : "Reconciliation job enqueued for slot",
  );
  return outcome;
}

export interface SchedulerOptions {
  now?: () => Date;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: SchedulerLogger;
}

interface ScheduledTaskEntry {
  readonly name: string;
  readonly parsedCron: ParsedCron;
  readonly task: ScheduledTaskFn;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Slot-based UTC cron scheduler with injectable clock/timers and an in-process per-slot guard.
 */
export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTaskEntry>();
  private readonly executedSlots = new Set<string>();
  private readonly nowFn: () => Date;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly customLogger?: SchedulerLogger;

  constructor(options: SchedulerOptions = {}) {
    this.nowFn = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle));
    this.customLogger = options.logger;
  }

  private getLogger(): SchedulerLogger {
    return this.customLogger ?? getDefaultLogger();
  }

  /**
   * Schedule a named task with a 5-field UTC cron expression.
   * Throws synchronously if `cronExpression` is invalid.
   */
  schedule(name: string, cronExpression: string, task: ScheduledTaskFn): void {
    const parsedCron = parseCron(cronExpression);

    if (this.tasks.has(name)) {
      this.getLogger().warn({ name }, "Task already scheduled, skipping");
      return;
    }

    const entry = {
      name,
      parsedCron,
      task,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    this.tasks.set(name, entry);
    this.armNextSlot(entry, this.nowFn());
  }

  private armNextSlot(entry: ScheduledTaskEntry, referenceDate: Date): void {
    const nextSlot = nextCronSlot(entry.parsedCron, referenceDate);
    const delayMs = Math.max(0, nextSlot.getTime() - this.nowFn().getTime());

    this.getLogger().info(
      {
        name: entry.name,
        cron: entry.parsedCron.expression,
        nextFireTime: nextSlot.toISOString(),
        slot: formatSlotIsoMinute(nextSlot),
        delayMs,
      },
      "Task scheduled",
    );

    this.armTimerUntilSlot(entry, nextSlot);
  }

  private armTimerUntilSlot(entry: ScheduledTaskEntry, targetSlot: Date): void {
    const remainingMs = Math.max(0, targetSlot.getTime() - this.nowFn().getTime());
    const waitMs = Math.min(remainingMs, MAX_TIMEOUT_MS);

    entry.timer = this.setTimeoutFn(() => {
      if (this.tasks.get(entry.name) !== entry) {
        return;
      }
      if (this.nowFn().getTime() < targetSlot.getTime()) {
        this.armTimerUntilSlot(entry, targetSlot);
        return;
      }
      void this.fireSlot(entry, targetSlot);
    }, waitMs);
  }

  /**
   * Execute `name` for `slotDate` at most once per `(name, slotIso)` using the in-process guard.
   */
  async runSlotIfNotExecuted(name: string, slotDate: Date): Promise<boolean> {
    const entry = this.tasks.get(name);
    if (!entry) {
      return false;
    }
    const slotIso = formatSlotIsoMinute(slotDate);
    const slotKey = `${entry.name}:${slotIso}`;
    const log = this.getLogger();
    if (this.executedSlots.has(slotKey)) {
      log.info({ name: entry.name, slot: slotIso }, "Skipping duplicate in-process slot execution");
      return false;
    }
    addBoundedSlot(this.executedSlots, slotKey);

    try {
      log.info({ name: entry.name, cron: entry.parsedCron.expression, slot: slotIso }, "Running scheduled task");
      const result = await entry.task(slotDate);
      const outcome: SchedulerTaskOutcome = result === "deduped" ? "deduped" : "enqueued";
      schedulerRunsTotal.inc({ task: entry.name, outcome });
    } catch (error: unknown) {
      schedulerRunsTotal.inc({ task: entry.name, outcome: "error" });
      log.error(
        {
          name: entry.name,
          slot: slotIso,
          error: error instanceof Error ? error.message : String(error),
        },
        "Scheduled task failed",
      );
    }
    return true;
  }

  private async fireSlot(entry: ScheduledTaskEntry, slotDate: Date): Promise<void> {
    try {
      await this.runSlotIfNotExecuted(entry.name, slotDate);
    } finally {
      if (this.tasks.get(entry.name) === entry) {
        const nextRef = new Date(Math.max(this.nowFn().getTime(), slotDate.getTime()));
        this.armNextSlot(entry, nextRef);
      }
    }
  }

  /**
   * Unschedule a single named task and clear its active timer.
   */
  unschedule(name: string): void {
    const entry = this.tasks.get(name);
    if (entry) {
      this.clearTimeoutFn(entry.timer);
      this.tasks.delete(name);
      this.getLogger().info({ name }, "Task unscheduled");
    }
  }

  /**
   * Stop all scheduled tasks and clear active timers.
   */
  stopAll(): void {
    for (const [name, entry] of this.tasks.entries()) {
      this.clearTimeoutFn(entry.timer);
      this.getLogger().info({ name }, "Task stopped");
    }
    this.tasks.clear();
  }
}

export const scheduler = new Scheduler();

export interface InitializeSchedulerOptions extends SchedulerOptions {
  enabled?: boolean;
  schedule?: string;
  queue?: ReconciliationQueueLike;
  schedulerInstance?: Scheduler;
}

let activeScheduler: Scheduler = scheduler;

/**
 * Initialize scheduled tasks based on environment configuration.
 */
export function initializeScheduler(options: InitializeSchedulerOptions = {}): Scheduler {
  const log = options.logger ?? getDefaultLogger();
  const enabled = options.enabled ?? getDefaultEnv().RECONCILIATION_ENABLED;
  const scheduleExpr = options.schedule ?? getDefaultEnv().RECONCILIATION_SCHEDULE;

  const target = options.schedulerInstance ?? scheduler;
  activeScheduler = target;

  if (!enabled) {
    log.info("Reconciliation scheduler disabled");
    return target;
  }

  const queue = options.queue ?? getDefaultReconciliationQueue();
  target.schedule("reconciliation", scheduleExpr, async (slotDate) => {
    log.info({ slot: formatSlotIsoMinute(slotDate) }, "Scheduling global reconciliation job via BullMQ");
    return enqueueReconciliationJob(slotDate, queue, log);
  });

  log.info("Scheduler initialized");
  return target;
}

/**
 * Stop all scheduled tasks (useful for testing or graceful shutdown).
 */
export function stopScheduler(): void {
  activeScheduler.stopAll();
  if (activeScheduler !== scheduler) {
    scheduler.stopAll();
  }
}
