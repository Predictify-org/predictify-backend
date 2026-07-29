/**
 * circuitBreakerService.ts
 *
 * In-process circuit breaker registry for indexer and webhook workers.
 *
 * The circuit breakers are simple boolean flags that the indexer worker
 * and webhook worker check before processing work. When a breaker is
 * "enabled" (closed), the worker processes normally. When "disabled" (open),
 * the worker skips its work loop and logs a warning.
 *
 * State is stored in-memory and resets on process restart. This is intentional
 * for an admin emergency stop; persistent state can be added later if needed.
 */

export type CircuitBreakerType = "indexer" | "webhook";

export interface CircuitBreakerState {
  type: CircuitBreakerType;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export class CircuitBreakerNotFoundError extends Error {
  status = 404;
  code = "not_found";
  constructor(type: CircuitBreakerType) {
    super(`Circuit breaker '${type}' not found`);
    Object.setPrototypeOf(this, CircuitBreakerNotFoundError.prototype);
  }
}

export class CircuitBreakerConflictError extends Error {
  status = 409;
  code = "circuit_breaker_conflict";
  constructor(type: CircuitBreakerType, current: boolean) {
    super(`Circuit breaker '${type}' is already ${current ? "enabled" : "disabled"}`);
    Object.setPrototypeOf(this, CircuitBreakerConflictError.prototype);
  }
}

const store = new Map<CircuitBreakerType, CircuitBreakerState>();

function getInitialState(type: CircuitBreakerType): CircuitBreakerState {
  return {
    type,
    enabled: true,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };
}

function ensureInitialized(): void {
  if (!store.has("indexer")) {
    store.set("indexer", getInitialState("indexer"));
  }
  if (!store.has("webhook")) {
    store.set("webhook", getInitialState("webhook"));
  }
}

/** Test-only helper: wipe all breakers so suites start from a clean slate. */
export function resetCircuitBreakersForTests(): void {
  store.clear();
  ensureInitialized();
}

export function listCircuitBreakers(): CircuitBreakerState[] {
  ensureInitialized();
  return Array.from(store.values()).sort((a, b) => a.type.localeCompare(b.type));
}

export function getCircuitBreaker(type: CircuitBreakerType): CircuitBreakerState {
  ensureInitialized();
  const state = store.get(type);
  if (!state) {
    throw new CircuitBreakerNotFoundError(type);
  }
  return state;
}

export function setCircuitBreaker(
  type: CircuitBreakerType,
  enabled: boolean,
  actor: string,
): CircuitBreakerState {
  ensureInitialized();
  const existing = store.get(type);
  if (!existing) {
    throw new CircuitBreakerNotFoundError(type);
  }
  if (existing.enabled === enabled) {
    throw new CircuitBreakerConflictError(type, enabled);
  }
  const updated: CircuitBreakerState = {
    ...existing,
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  store.set(type, updated);
  return updated;
}

export function isCircuitBreakerEnabled(type: CircuitBreakerType): boolean {
  ensureInitialized();
  return store.get(type)?.enabled ?? true;
}