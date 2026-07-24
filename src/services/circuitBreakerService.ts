import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

export type CircuitType = "indexer" | "webhook";

export interface CircuitBreakerState {
  type: CircuitType;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_STATE: Record<CircuitType, CircuitBreakerState> = {
  indexer: {
    type: "indexer",
    enabled: false,
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
  },
  webhook: {
    type: "webhook",
    enabled: false,
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
  },
};

const store = new Map<CircuitType, CircuitBreakerState>([
  ["indexer", DEFAULT_STATE.indexer],
  ["webhook", DEFAULT_STATE.webhook],
]);

export function resetCircuitBreakersForTests(): void {
  store.set("indexer", { ...DEFAULT_STATE.indexer });
  store.set("webhook", { ...DEFAULT_STATE.webhook });
}

export function getCircuitBreaker(type: CircuitType): CircuitBreakerState {
  const state = store.get(type);
  if (!state) {
    return DEFAULT_STATE[type];
  }
  return state;
}

export function getAllCircuitBreakers(): CircuitBreakerState[] {
  return Array.from(store.values()).sort((a, b) => a.type.localeCompare(b.type));
}

export function setCircuitBreaker(
  type: CircuitType,
  enabled: boolean,
  updatedBy: string,
): CircuitBreakerState {
  const existing = store.get(type) ?? DEFAULT_STATE[type];
  const updated: CircuitBreakerState = {
    ...existing,
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  store.set(type, updated);
  logger.info(
    { reqId: getRequestId(), type, enabled, actor: updatedBy },
    "circuit_breaker_toggled",
  );
  return updated;
}

export function isCircuitOpen(type: CircuitType): boolean {
  return store.get(type)?.enabled ?? false;
}