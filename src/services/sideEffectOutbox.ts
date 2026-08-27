import { randomUUID } from "node:crypto";

export const OUTBOX_EVENT_TYPES = {
  PAYOUT: "payout",
  NOTIFICATION: "notification",
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];
export type OutboxStatus = "pending" | "processing" | "completed" | "dead_letter";

export type OutboxEvent = {
  id: string;
  idempotencyKey: string;
  type: OutboxEventType;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  availableAt: number;
  leaseUntil: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type OutboxProcessingOptions = {
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  leaseMs?: number;
};

export type OutboxProcessingResult = {
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
};

export type OutboxErrorCode = "INVALID_OPTIONS" | "INVALID_EVENT";

export class OutboxError extends Error {
  readonly code: OutboxErrorCode;

  constructor(code: OutboxErrorCode, message: string) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
  }
}

const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_MAX_ATTEMPTS = 20;
const DEFAULT_BACKOFF_BASE_MS = 250;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_LEASE_MS = 30_000;

type StagedSideEffect = { key: string; value: Record<string, unknown> };
type StagedEvent = {
  idempotencyKey: string;
  type: OutboxEventType;
  payload: Record<string, unknown>;
};

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(payload);
}

function positiveBounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new OutboxError("INVALID_OPTIONS", "outbox limits must be positive integers");
  }
  return Math.min(value, maximum);
}

function nonNegativeBounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new OutboxError("INVALID_OPTIONS", "outbox delays must be non-negative integers");
  }
  return Math.min(value, maximum);
}

function snapshot(event: OutboxEvent): OutboxEvent {
  return { ...event, payload: clonePayload(event.payload) };
}

/** Transaction context that stages business writes and their outbox records. */
export class OutboxTransaction {
  private readonly sideEffects: StagedSideEffect[] = [];
  private readonly events: StagedEvent[] = [];

  putSideEffect(key: string, value: Record<string, unknown>): void {
    if (key.length === 0) {
      throw new OutboxError("INVALID_EVENT", "side-effect key must be non-empty");
    }
    this.sideEffects.push({ key, value: clonePayload(value) });
  }

  enqueue(
    idempotencyKey: string,
    type: OutboxEventType,
    payload: Record<string, unknown>,
  ): void {
    if (idempotencyKey.length === 0) {
      throw new OutboxError("INVALID_EVENT", "outbox idempotency key must be non-empty");
    }
    if (!Object.values(OUTBOX_EVENT_TYPES).includes(type)) {
      throw new OutboxError("INVALID_EVENT", "outbox event type is not recognized");
    }
    if (this.events.some((event) => event.idempotencyKey === idempotencyKey)) return;
    this.events.push({ idempotencyKey, type, payload: clonePayload(payload) });
  }

  get stagedSideEffects(): readonly StagedSideEffect[] {
    return this.sideEffects;
  }

  get stagedEvents(): readonly StagedEvent[] {
    return this.events;
  }
}

/**
 * In-memory transactional outbox used by the development backend and tests.
 * A transaction stages the business-side effect and its delivery record; both
 * become visible at one commit boundary. Production persistence can implement
 * the same interface with a database transaction without changing processors.
 */
export class SideEffectOutbox {
  private readonly effects = new Map<string, Record<string, unknown>>();
  private readonly events = new Map<string, OutboxEvent>();
  private readonly eventKeys = new Map<string, string>();

  transaction(work: (transaction: OutboxTransaction) => void, now = Date.now): void {
    const transaction = new OutboxTransaction();
    work(transaction);
    const duplicateEffect = transaction.stagedSideEffects.find((entry) =>
      this.effects.has(entry.key),
    );
    const duplicateEvent = transaction.stagedEvents.find((entry) =>
      this.eventKeys.has(entry.idempotencyKey),
    );
    if (duplicateEffect || duplicateEvent) return;
    const createdAt = now();
    for (const effect of transaction.stagedSideEffects) {
      this.effects.set(effect.key, clonePayload(effect.value));
    }
    for (const event of transaction.stagedEvents) {
      if (this.eventKeys.has(event.idempotencyKey)) continue;
      const id = randomUUID();
      this.events.set(id, {
        id,
        idempotencyKey: event.idempotencyKey,
        type: event.type,
        payload: clonePayload(event.payload),
        status: "pending",
        attempts: 0,
        availableAt: createdAt,
        leaseUntil: null,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      });
      this.eventKeys.set(event.idempotencyKey, id);
    }
  }

  enqueue(
    idempotencyKey: string,
    type: OutboxEventType,
    payload: Record<string, unknown>,
    now = Date.now,
  ): OutboxEvent {
    this.transaction((transaction) => transaction.enqueue(idempotencyKey, type, payload), now);
    const existing = this.getByKey(idempotencyKey);
    if (!existing) {
      throw new OutboxError("INVALID_EVENT", "outbox event was not committed");
    }
    return existing;
  }

  getByKey(idempotencyKey: string): OutboxEvent | undefined {
    const id = this.eventKeys.get(idempotencyKey);
    return id ? this.events.get(id) && snapshot(this.events.get(id) as OutboxEvent) : undefined;
  }

  get(id: string): OutboxEvent | undefined {
    const event = this.events.get(id);
    return event ? snapshot(event) : undefined;
  }

  getSideEffect(key: string): Record<string, unknown> | undefined {
    const value = this.effects.get(key);
    return value ? clonePayload(value) : undefined;
  }

  list(status?: OutboxStatus): OutboxEvent[] {
    return [...this.events.values()]
      .filter((event) => status === undefined || event.status === status)
      .sort((left, right) => left.createdAt - right.createdAt || left.idempotencyKey.localeCompare(right.idempotencyKey))
      .map(snapshot);
  }

  private reclaimExpired(now: number): void {
    for (const event of this.events.values()) {
      if (event.status === "processing" && event.leaseUntil !== null && event.leaseUntil <= now) {
        event.status = "pending";
        event.leaseUntil = null;
        event.availableAt = now;
        event.updatedAt = now;
      }
    }
  }

  claim(limit = 100, now = Date.now, leaseMs = DEFAULT_LEASE_MS): OutboxEvent[] {
    const boundedLimit = positiveBounded(limit, 100, 1_000);
    const boundedLease = nonNegativeBounded(leaseMs, DEFAULT_LEASE_MS, MAX_BACKOFF_MS);
    this.reclaimExpired(now());
    const candidates = [...this.events.values()]
      .filter((event) => event.status === "pending" && event.availableAt <= now())
      .sort((left, right) => left.createdAt - right.createdAt || left.idempotencyKey.localeCompare(right.idempotencyKey))
      .slice(0, boundedLimit);
    const claimedAt = now();
    return candidates.map((event) => {
      event.status = "processing";
      event.attempts += 1;
      event.leaseUntil = claimedAt + boundedLease;
      event.updatedAt = claimedAt;
      return snapshot(event);
    });
  }

  async process(
    handler: (event: OutboxEvent) => Promise<void>,
    options: OutboxProcessingOptions = {},
    now: () => number = Date.now,
  ): Promise<OutboxProcessingResult> {
    const maxAttempts = positiveBounded(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS);
    const base = nonNegativeBounded(options.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, MAX_BACKOFF_MS);
    const maximum = nonNegativeBounded(options.backoffMaxMs, MAX_BACKOFF_MS, MAX_BACKOFF_MS);
    const lease = nonNegativeBounded(options.leaseMs, DEFAULT_LEASE_MS, MAX_BACKOFF_MS);
    const claimed = this.claim(100, now, lease);
    const result: OutboxProcessingResult = { claimed: claimed.length, completed: 0, retried: 0, deadLettered: 0 };
    for (const event of claimed) {
      const current = this.events.get(event.id);
      if (!current || current.status !== "processing") continue;
      try {
        await handler(snapshot(event));
        current.status = "completed";
        current.leaseUntil = null;
        current.lastError = null;
        current.updatedAt = now();
        result.completed += 1;
      } catch (error) {
        current.lastError = error instanceof Error ? error.message : "outbox handler failed";
        current.leaseUntil = null;
        current.updatedAt = now();
        if (current.attempts >= maxAttempts) {
          current.status = "dead_letter";
          result.deadLettered += 1;
        } else {
          current.status = "pending";
          const delay = Math.min(maximum, base * 2 ** Math.max(0, current.attempts - 1));
          current.availableAt = current.updatedAt + delay;
          result.retried += 1;
        }
      }
    }
    return result;
  }
}

export function enqueuePayout(
  outbox: SideEffectOutbox,
  payoutId: string,
  payload: Record<string, unknown>,
): OutboxEvent {
  return outbox.enqueue(`payout:${payoutId}`, OUTBOX_EVENT_TYPES.PAYOUT, payload);
}

export function enqueueNotification(
  outbox: SideEffectOutbox,
  notificationId: string,
  payload: Record<string, unknown>,
): OutboxEvent {
  return outbox.enqueue(`notification:${notificationId}`, OUTBOX_EVENT_TYPES.NOTIFICATION, payload);
}
