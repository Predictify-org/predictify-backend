/**
 * circuitBreaker.test.ts
 *
 * Unit tests for src/lib/circuitBreaker.ts
 *
 * Tests cover:
 *  - Default configuration
 *  - CLOSED state: successful calls and failure counting
 *  - OPEN state: fast-fail, CircuitOpenError, retryAfterMs
 *  - HALF_OPEN state: probe success → CLOSED, probe failure → OPEN
 *  - Automatic OPEN → HALF_OPEN transition after halfOpenAfterMs
 *  - successThreshold > 1 (requires multiple consecutive successes)
 *  - CircuitOpenError is not counted as a failure
 *  - resetCircuitBreakersForTests / forceCircuitStateForTests helpers
 *  - snapshot() accuracy
 *  - Registry isolation: two different names are independent
 */

import {
  getCircuitBreaker,
  resetCircuitBreakersForTests,
  forceCircuitStateForTests,
  CircuitOpenError,
  type CircuitBreakerSnapshot,
} from "../src/lib/circuitBreaker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const succeed = <T>(value: T) => () => Promise.resolve(value);
const fail = (msg = "downstream failure") => () => Promise.reject(new Error(msg));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetCircuitBreakersForTests();
});

// ---------------------------------------------------------------------------
// CircuitOpenError
// ---------------------------------------------------------------------------

describe("CircuitOpenError", () => {
  it("has the correct name", () => {
    const err = new CircuitOpenError("my-circuit", Date.now());
    expect(err.name).toBe("CircuitOpenError");
  });

  it("carries the circuit name", () => {
    const err = new CircuitOpenError("svc-a", 12345);
    expect(err.circuitName).toBe("svc-a");
  });

  it("carries openedAt timestamp", () => {
    const now = Date.now();
    const err = new CircuitOpenError("svc-b", now);
    expect(err.openedAt).toBe(now);
  });

  it("is instanceof Error", () => {
    const err = new CircuitOpenError("x", 0);
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof CircuitOpenError", () => {
    const err = new CircuitOpenError("x", 0);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });
});

// ---------------------------------------------------------------------------
// getCircuitBreaker — initial state
// ---------------------------------------------------------------------------

describe("getCircuitBreaker — initial state", () => {
  it("starts in CLOSED state", () => {
    const cb = getCircuitBreaker("cb-test");
    expect(cb.state).toBe("CLOSED");
  });

  it("snapshot reflects defaults", () => {
    const cb = getCircuitBreaker("cb-defaults");
    const snap: CircuitBreakerSnapshot = cb.snapshot();
    expect(snap.state).toBe("CLOSED");
    expect(snap.failures).toBe(0);
    expect(snap.successes).toBe(0);
    expect(snap.openedAt).toBeNull();
    expect(snap.failureThreshold).toBe(5);
    expect(snap.successThreshold).toBe(1);
    expect(snap.halfOpenAfterMs).toBe(30_000);
  });

  it("snapshot reflects custom options", () => {
    const cb = getCircuitBreaker("cb-custom", {
      failureThreshold: 2,
      successThreshold: 3,
      halfOpenAfterMs: 5_000,
    });
    const snap = cb.snapshot();
    expect(snap.failureThreshold).toBe(2);
    expect(snap.successThreshold).toBe(3);
    expect(snap.halfOpenAfterMs).toBe(5_000);
  });

  it("two handles for the same name share the same underlying state", async () => {
    // Both handles wrap the same registry entry.  Trip the breaker via one
    // handle and confirm the other observes the same state.
    const a = getCircuitBreaker("same-name", { failureThreshold: 1 });
    const b = getCircuitBreaker("same-name");

    // Execute a failing call through `a` to trip the breaker.
    await a.execute(fail()).catch(() => {});

    expect(a.state).toBe("OPEN");
    expect(b.state).toBe("OPEN");
  });

  it("different names have independent state", () => {
    getCircuitBreaker("alpha");
    getCircuitBreaker("beta");
    forceCircuitStateForTests("alpha", "OPEN");
    expect(getCircuitBreaker("beta").state).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// CLOSED state
// ---------------------------------------------------------------------------

describe("CLOSED state", () => {
  it("execute resolves the return value", async () => {
    const cb = getCircuitBreaker("closed-resolve");
    const result = await cb.execute(succeed(42));
    expect(result).toBe(42);
  });

  it("execute propagates rejection without tripping breaker below threshold", async () => {
    const cb = getCircuitBreaker("closed-below-threshold", { failureThreshold: 5 });
    await expect(cb.execute(fail())).rejects.toThrow("downstream failure");
    expect(cb.state).toBe("CLOSED");
    expect(cb.snapshot().failures).toBe(1);
  });

  it("each failure increments the counter", async () => {
    const cb = getCircuitBreaker("closed-counter", { failureThreshold: 10 });
    for (let i = 1; i <= 4; i++) {
      await cb.execute(fail()).catch(() => {});
      expect(cb.snapshot().failures).toBe(i);
    }
  });

  it("success resets the failure counter", async () => {
    const cb = getCircuitBreaker("closed-reset", { failureThreshold: 5 });
    await cb.execute(fail()).catch(() => {});
    await cb.execute(fail()).catch(() => {});
    expect(cb.snapshot().failures).toBe(2);

    await cb.execute(succeed("ok"));
    expect(cb.snapshot().failures).toBe(0);
  });

  it("trips to OPEN after failureThreshold failures", async () => {
    const cb = getCircuitBreaker("closed-trip", { failureThreshold: 3 });
    await cb.execute(fail()).catch(() => {});
    await cb.execute(fail()).catch(() => {});
    expect(cb.state).toBe("CLOSED");
    await cb.execute(fail()).catch(() => {});
    expect(cb.state).toBe("OPEN");
  });

  it("openedAt is null while CLOSED", () => {
    const cb = getCircuitBreaker("closed-openat");
    expect(cb.snapshot().openedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OPEN state
// ---------------------------------------------------------------------------

describe("OPEN state", () => {
  it("execute throws CircuitOpenError immediately", async () => {
    forceCircuitStateForTests("open-fast", "OPEN");
    const cb = getCircuitBreaker("open-fast");
    await expect(cb.execute(succeed("x"))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("the wrapped function is never called when OPEN", async () => {
    forceCircuitStateForTests("open-noop", "OPEN");
    const cb = getCircuitBreaker("open-noop");
    const fn = jest.fn().mockResolvedValue("result");
    await cb.execute(fn).catch(() => {});
    expect(fn).not.toHaveBeenCalled();
  });

  it("CircuitOpenError carries the circuit name", async () => {
    forceCircuitStateForTests("open-name", "OPEN");
    const cb = getCircuitBreaker("open-name");
    const err = await cb.execute(succeed("x")).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).circuitName).toBe("open-name");
  });

  it("openedAt is set in the snapshot", () => {
    const before = Date.now();
    forceCircuitStateForTests("open-ts", "OPEN");
    const snap = getCircuitBreaker("open-ts").snapshot();
    expect(snap.openedAt).not.toBeNull();
    expect(snap.openedAt!).toBeGreaterThanOrEqual(before);
  });

  it("naturally tripped: openedAt is recorded", async () => {
    const before = Date.now();
    const cb = getCircuitBreaker("open-natural", { failureThreshold: 1 });
    await cb.execute(fail()).catch(() => {});
    const snap = cb.snapshot();
    expect(snap.state).toBe("OPEN");
    expect(snap.openedAt).not.toBeNull();
    expect(snap.openedAt!).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// OPEN → HALF_OPEN transition
// ---------------------------------------------------------------------------

describe("OPEN → HALF_OPEN transition", () => {
  it("transitions to HALF_OPEN after halfOpenAfterMs elapses", async () => {
    jest.useFakeTimers();
    try {
      forceCircuitStateForTests("half-time", "OPEN", { halfOpenAfterMs: 500 });
      const cb = getCircuitBreaker("half-time", { halfOpenAfterMs: 500 });

      expect(cb.state).toBe("OPEN");

      jest.advanceTimersByTime(600);

      // Accessing state triggers the time-based transition
      expect(cb.state).toBe("HALF_OPEN");
    } finally {
      jest.useRealTimers();
    }
  });

  it("stays OPEN before halfOpenAfterMs elapses", () => {
    jest.useFakeTimers();
    try {
      forceCircuitStateForTests("half-wait", "OPEN", { halfOpenAfterMs: 1_000 });
      const cb = getCircuitBreaker("half-wait", { halfOpenAfterMs: 1_000 });

      jest.advanceTimersByTime(500);
      expect(cb.state).toBe("OPEN");
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN state
// ---------------------------------------------------------------------------

describe("HALF_OPEN state", () => {
  it("probe success resets to CLOSED (successThreshold = 1)", async () => {
    forceCircuitStateForTests("half-success", "HALF_OPEN");
    const cb = getCircuitBreaker("half-success");
    await cb.execute(succeed("ok"));
    expect(cb.state).toBe("CLOSED");
  });

  it("probe success resets failure and success counters", async () => {
    forceCircuitStateForTests("half-counters", "HALF_OPEN");
    const cb = getCircuitBreaker("half-counters");
    await cb.execute(succeed("ok"));
    const snap = cb.snapshot();
    expect(snap.failures).toBe(0);
    expect(snap.successes).toBe(0);
    expect(snap.openedAt).toBeNull();
  });

  it("probe failure trips back to OPEN", async () => {
    forceCircuitStateForTests("half-fail", "HALF_OPEN");
    const cb = getCircuitBreaker("half-fail");
    await cb.execute(fail()).catch(() => {});
    expect(cb.state).toBe("OPEN");
  });

  it("probe failure updates openedAt", async () => {
    const before = Date.now();
    forceCircuitStateForTests("half-openat", "HALF_OPEN");
    const cb = getCircuitBreaker("half-openat");
    await cb.execute(fail()).catch(() => {});
    const snap = cb.snapshot();
    expect(snap.openedAt).not.toBeNull();
    expect(snap.openedAt!).toBeGreaterThanOrEqual(before);
  });

  it("requires successThreshold successes before closing (threshold = 3)", async () => {
    forceCircuitStateForTests("half-thresh", "HALF_OPEN", { successThreshold: 3 });
    const cb = getCircuitBreaker("half-thresh", { successThreshold: 3 });

    await cb.execute(succeed(1));
    expect(cb.state).toBe("HALF_OPEN");
    await cb.execute(succeed(2));
    expect(cb.state).toBe("HALF_OPEN");
    await cb.execute(succeed(3));
    expect(cb.state).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// CircuitOpenError not counted as failure
// ---------------------------------------------------------------------------

describe("CircuitOpenError passthrough", () => {
  it("does not increment failure counter when OPEN throws CircuitOpenError", async () => {
    forceCircuitStateForTests("open-no-count", "OPEN");
    const cb = getCircuitBreaker("open-no-count");
    const snap1 = cb.snapshot();

    await cb.execute(succeed("x")).catch(() => {});

    const snap2 = cb.snapshot();
    expect(snap2.failures).toBe(snap1.failures);
  });
});

// ---------------------------------------------------------------------------
// resetCircuitBreakersForTests
// ---------------------------------------------------------------------------

describe("resetCircuitBreakersForTests", () => {
  it("clears all registered breakers", () => {
    forceCircuitStateForTests("reset-a", "OPEN");
    forceCircuitStateForTests("reset-b", "OPEN");
    resetCircuitBreakersForTests();

    // After reset, a fresh getCircuitBreaker should start in CLOSED
    expect(getCircuitBreaker("reset-a").state).toBe("CLOSED");
    expect(getCircuitBreaker("reset-b").state).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// forceCircuitStateForTests
// ---------------------------------------------------------------------------

describe("forceCircuitStateForTests", () => {
  it("can force CLOSED", () => {
    forceCircuitStateForTests("force-closed", "CLOSED");
    expect(getCircuitBreaker("force-closed").state).toBe("CLOSED");
  });

  it("can force OPEN", () => {
    forceCircuitStateForTests("force-open", "OPEN");
    expect(getCircuitBreaker("force-open").state).toBe("OPEN");
  });

  it("can force HALF_OPEN", () => {
    forceCircuitStateForTests("force-half", "HALF_OPEN");
    expect(getCircuitBreaker("force-half").state).toBe("HALF_OPEN");
  });

  it("sets openedAt when forcing OPEN", () => {
    const before = Date.now();
    forceCircuitStateForTests("force-openat", "OPEN");
    const snap = getCircuitBreaker("force-openat").snapshot();
    expect(snap.openedAt).not.toBeNull();
    expect(snap.openedAt!).toBeGreaterThanOrEqual(before);
  });

  it("clears openedAt when forcing CLOSED", () => {
    forceCircuitStateForTests("force-clear-openat", "OPEN");
    forceCircuitStateForTests("force-clear-openat", "CLOSED");
    const snap = getCircuitBreaker("force-clear-openat").snapshot();
    expect(snap.openedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// snapshot() — name field
// ---------------------------------------------------------------------------

describe("snapshot name field", () => {
  it("includes the circuit name", () => {
    const cb = getCircuitBreaker("named-circuit");
    expect(cb.snapshot().name).toBe("named-circuit");
  });
});
