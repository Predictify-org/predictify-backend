/**
 * circuitBreakerService.test.ts
 *
 * Unit tests for the in-memory circuit breaker service.
 */

import {
  listCircuitBreakers,
  getCircuitBreaker,
  setCircuitBreaker,
  isCircuitBreakerEnabled,
  resetCircuitBreakersForTests,
  CircuitBreakerNotFoundError,
  CircuitBreakerConflictError,
  type CircuitBreakerState,
} from "../src/services/circuitBreakerService";

beforeEach(() => {
  resetCircuitBreakersForTests();
});

describe("circuitBreakerService — unit tests", () => {
  it("initializes with both breakers enabled", () => {
    const breakers = listCircuitBreakers();
    expect(breakers).toHaveLength(2);
    expect(breakers.find((b) => b.type === "indexer")?.enabled).toBe(true);
    expect(breakers.find((b) => b.type === "webhook")?.enabled).toBe(true);
  });

  it("lists breakers in alphabetical order", () => {
    const breakers = listCircuitBreakers();
    expect(breakers.map((b) => b.type)).toEqual(["indexer", "webhook"]);
  });

  it("gets a specific breaker by type", () => {
    const indexer = getCircuitBreaker("indexer");
    expect(indexer.type).toBe("indexer");
    expect(indexer.enabled).toBe(true);
    expect(indexer.updatedBy).toBeNull();
  });

  it("throws CircuitBreakerNotFoundError for unknown type", () => {
    // @ts-expect-error testing invalid type
    expect(() => getCircuitBreaker("unknown")).toThrow(CircuitBreakerNotFoundError);
  });

  it("toggles a breaker from enabled to disabled", () => {
    const updated = setCircuitBreaker("indexer", false, "admin-123");
    expect(updated.enabled).toBe(false);
    expect(updated.updatedBy).toBe("admin-123");
    expect(updated.updatedAt).toBeTruthy();

    const current = getCircuitBreaker("indexer");
    expect(current.enabled).toBe(false);
  });

  it("toggles a breaker from disabled to enabled", () => {
    setCircuitBreaker("indexer", false, "admin-123");
    const updated = setCircuitBreaker("indexer", true, "admin-456");
    expect(updated.enabled).toBe(true);
    expect(updated.updatedBy).toBe("admin-456");
  });

  it("throws CircuitBreakerConflictError when setting to same state", () => {
    setCircuitBreaker("webhook", false, "admin-123");
    expect(() => setCircuitBreaker("webhook", false, "admin-456")).toThrow(
      CircuitBreakerConflictError,
    );
  });

  it("isCircuitBreakerEnabled returns current state", () => {
    expect(isCircuitBreakerEnabled("indexer")).toBe(true);
    setCircuitBreaker("indexer", false, "admin-123");
    expect(isCircuitBreakerEnabled("indexer")).toBe(false);
    setCircuitBreaker("indexer", true, "admin-123");
    expect(isCircuitBreakerEnabled("indexer")).toBe(true);
  });

  it("resetCircuitBreakersForTests clears and re-initializes", () => {
    setCircuitBreaker("indexer", false, "admin-123");
    setCircuitBreaker("webhook", false, "admin-123");
    resetCircuitBreakersForTests();
    const breakers = listCircuitBreakers();
    expect(breakers.every((b) => b.enabled)).toBe(true);
    expect(breakers.every((b) => b.updatedBy === null)).toBe(true);
  });

  it("preserves updatedAt timestamp on each toggle", () => {
    const first = setCircuitBreaker("indexer", false, "admin-1");
    const firstTime = first.updatedAt;

    // Small delay to ensure timestamp changes
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy wait
    }

    const second = setCircuitBreaker("indexer", true, "admin-2");
    expect(second.updatedAt).not.toBe(firstTime);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(
      new Date(firstTime).getTime(),
    );
  });
});