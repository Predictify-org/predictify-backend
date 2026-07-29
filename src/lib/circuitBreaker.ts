/**
 * @module lib/circuitBreaker
 *
 * Per-endpoint circuit breaker with CLOSED → OPEN → HALF_OPEN state machine.
 *
 * Behaviour
 * ---------
 *
 * CLOSED (normal operation)
 *   All calls pass through. Failures are counted in a rolling window. Once
 *   `failureThreshold` failures accumulate within `windowMs`, the breaker
 *   transitions to OPEN.
 *
 * OPEN (fast-fail)
 *   All calls are rejected immediately with a `CircuitOpenError` (callers
 *   should translate this to HTTP 503). After `resetTimeoutMs` has elapsed
 *   the breaker transitions to HALF_OPEN to probe whether the downstream has
 *   recovered.
 *
 * HALF_OPEN (probe)
 *   A single call is allowed through as a probe. If it succeeds the breaker
 *   returns to CLOSED and the failure counts are reset. If it fails the
 *   breaker returns to OPEN and the reset timeout restarts.
 *
 * Usage
 * -----
 *
 * ```ts
 * import { CircuitBreaker } from "../lib/circuitBreaker";
 *
 * // One breaker instance per downstream endpoint (module-level singleton).
 * const dbBreaker = new CircuitBreaker("comments-db");
 * const httpBreaker = new CircuitBreaker("comments-outbound");
 *
 * // Wrap any async call with the breaker:
 * const result = await dbBreaker.fire(() => listMarketComments(id, cursor, limit));
 * ```
 *
 * Tuning
 * ------
 * Pass a `CircuitBreakerOptions` object to the constructor:
 *
 * | Option             | Default | Description                                         |
 * |--------------------|---------|-----------------------------------------------------|
 * | failureThreshold   | 5       | Failures in the window before opening               |
 * | windowMs           | 60 000  | Rolling window length in milliseconds               |
 * | resetTimeoutMs     | 30 000  | Time to stay OPEN before probing                    |
 *
 * Thread safety
 * -------------
 * Node.js is single-threaded, so the integer counters and state transitions
 * are inherently atomic within a single process. The breaker is *not*
 * distributed — each process maintains its own state. For multi-process
 * deployments, a shared backing store (Redis) would be needed.
 */

import { logger } from "../config/logger";

// ── Types & Errors ───────────────────────────────────────────────────────────

/** The three states of the circuit breaker. */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Options accepted by the {@link CircuitBreaker} constructor. */
export interface CircuitBreakerOptions {
  /**
   * Number of failures in the rolling window that cause the breaker to open.
   * @default 5
   */
  failureThreshold?: number;
  /**
   * Length of the rolling failure-count window in milliseconds.
   * Failures older than this are discarded.
   * @default 60_000
   */
  windowMs?: number;
  /**
   * How long the breaker stays OPEN before transitioning to HALF_OPEN
   * to attempt a probe call.
   * @default 30_000
   */
  resetTimeoutMs?: number;
}

/**
 * Thrown by {@link CircuitBreaker.fire} when the breaker is OPEN or when the
 * HALF_OPEN probe slot is already occupied. Callers should map this to HTTP 503.
 */
export class CircuitOpenError extends Error {
  public readonly name = "CircuitOpenError";
  public readonly breakerName: string;
  public readonly state: CircuitBreakerState;

  constructor(breakerName: string, state: CircuitBreakerState) {
    super(`Circuit breaker '${breakerName}' is ${state} — downstream call rejected`);
    this.breakerName = breakerName;
    this.state = state;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

// ── CircuitBreaker class ─────────────────────────────────────────────────────

/**
 * Per-endpoint circuit breaker with CLOSED / OPEN / HALF_OPEN state machine.
 *
 * Create one instance per logical downstream dependency and reuse it for the
 * lifetime of the process. Module-level singletons are the idiomatic pattern.
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly resetTimeoutMs: number;

  private _state: CircuitBreakerState = "CLOSED";
  /** Timestamps (ms since epoch) of recent failures within the rolling window. */
  private failureTimes: number[] = [];
  /** Wall-clock time at which the OPEN → HALF_OPEN transition may occur. */
  private openedAt: number | null = null;
  /** Guards the single probe slot when HALF_OPEN. */
  private halfOpenProbeInFlight = false;

  constructor(name: string, opts: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** The current state of the circuit breaker. */
  get state(): CircuitBreakerState {
    this._maybeTransitionToHalfOpen();
    return this._state;
  }

  /**
   * Fire the supplied async callable through the breaker.
   *
   * - CLOSED: calls through, records success/failure.
   * - OPEN:   throws {@link CircuitOpenError} immediately (fast-fail).
   * - HALF_OPEN: allows one probe call; success → CLOSED, failure → OPEN.
   *   If the probe slot is already occupied, throws {@link CircuitOpenError}.
   *
   * @param callable  Zero-argument async function wrapping the downstream call.
   * @returns The resolved value of `callable`.
   * @throws  {@link CircuitOpenError} when the breaker is OPEN or the HALF_OPEN
   *          probe slot is busy.
   * @throws  Whatever `callable` throws when it fails while the breaker is
   *          CLOSED or serving as the HALF_OPEN probe.
   */
  async fire<T>(callable: () => Promise<T>): Promise<T> {
    this._maybeTransitionToHalfOpen();

    if (this._state === "OPEN") {
      logger.warn(
        { breaker: this.name, state: this._state },
        "circuit_breaker_open_fast_fail",
      );
      throw new CircuitOpenError(this.name, this._state);
    }

    if (this._state === "HALF_OPEN") {
      if (this.halfOpenProbeInFlight) {
        // Probe already in flight; reject all other callers.
        logger.warn(
          { breaker: this.name, state: this._state },
          "circuit_breaker_half_open_probe_busy",
        );
        throw new CircuitOpenError(this.name, this._state);
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await callable();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    } finally {
      if (this._state === "HALF_OPEN") {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  /**
   * Reset the breaker to CLOSED and clear all failure tracking.
   * Intended for test suites; production code should not call this directly.
   */
  reset(): void {
    this._state = "CLOSED";
    this.failureTimes = [];
    this.openedAt = null;
    this.halfOpenProbeInFlight = false;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Prunes stale timestamps and returns the current failure count. */
  private _prunedFailureCount(): number {
    const cutoff = Date.now() - this.windowMs;
    this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
    return this.failureTimes.length;
  }

  /** Transitions from OPEN to HALF_OPEN if the reset timeout has elapsed. */
  private _maybeTransitionToHalfOpen(): void {
    if (
      this._state === "OPEN" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      this._state = "HALF_OPEN";
      this.halfOpenProbeInFlight = false;
      logger.info(
        { breaker: this.name, state: "HALF_OPEN" },
        "circuit_breaker_half_open",
      );
    }
  }

  private _onSuccess(): void {
    if (this._state === "HALF_OPEN") {
      logger.info(
        { breaker: this.name },
        "circuit_breaker_probe_success_closing",
      );
    }
    // Any success resets the breaker fully.
    this._state = "CLOSED";
    this.failureTimes = [];
    this.openedAt = null;
  }

  private _onFailure(): void {
    const now = Date.now();

    if (this._state === "HALF_OPEN") {
      // Probe failed — return to OPEN and restart the reset timer.
      this._state = "OPEN";
      this.openedAt = now;
      logger.warn(
        { breaker: this.name, state: "OPEN" },
        "circuit_breaker_probe_failed_reopened",
      );
      return;
    }

    // CLOSED — record failure and check threshold.
    this.failureTimes.push(now);
    const count = this._prunedFailureCount();

    if (count >= this.failureThreshold) {
      this._state = "OPEN";
      this.openedAt = now;
      logger.warn(
        {
          breaker: this.name,
          failures: count,
          threshold: this.failureThreshold,
          state: "OPEN",
        },
        "circuit_breaker_opened",
      );
    }
  }

  snapshot(): { state: CircuitBreakerState; failures: number; halfOpenAfterMs: number } {
    return {
      state: this.state,
      failures: this.failureTimes.length,
      halfOpenAfterMs: this.resetTimeoutMs,
    };
  }
}

// ── Global Registry ─────────────────────────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, opts);
    breakers.set(name, breaker);
  }
  return breaker;
}

export function resetCircuitBreakersForTests(): void {
  breakers.clear();
}

export function forceCircuitStateForTests(
  name: string,
  state: CircuitBreakerState,
  opts?: { halfOpenAfterMs?: number }
): void {
  const breaker = getCircuitBreaker(name);
  // @ts-ignore - access private fields for test overrides
  breaker._state = state;
  // @ts-ignore
  breaker.openedAt = state === "OPEN" || state === "HALF_OPEN" ? Date.now() : null;
  // @ts-ignore
  if (opts?.halfOpenAfterMs !== undefined) { breaker.resetTimeoutMs = opts.halfOpenAfterMs; }
}
