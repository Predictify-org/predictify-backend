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
 *   transitions to OPEN. Any success clears the accumulated failures.
 *
 * OPEN (fast-fail)
 *   All calls are rejected immediately with a `CircuitOpenError` (callers
 *   should translate this to HTTP 503). After `halfOpenAfterMs` has elapsed
 *   the breaker transitions to HALF_OPEN to probe whether the downstream has
 *   recovered.
 *
 * HALF_OPEN (probe)
 *   A single call at a time is allowed through as a probe; concurrent callers
 *   are fast-failed so a sick downstream is not stampeded. Once
 *   `successThreshold` probes have succeeded the breaker returns to CLOSED.
 *   Any probe failure sends it straight back to OPEN and restarts the timer.
 *
 * Usage
 * -----
 *
 * ```ts
 * import { getCircuitBreaker, CircuitOpenError } from "../lib/circuitBreaker";
 *
 * // One breaker per logical downstream dependency, resolved from the registry
 * // so every route/module sharing a name shares the same state.
 * const breaker = getCircuitBreaker("impersonate", { failureThreshold: 5 });
 *
 * try {
 *   const result = await breaker.execute(() => doDownstreamWork());
 * } catch (err) {
 *   if (err instanceof CircuitOpenError) {
 *     // fast-fail path → respond 503
 *   }
 * }
 * ```
 *
 * Tuning
 * ------
 * Pass a `CircuitBreakerOptions` object to `getCircuitBreaker` (or the
 * constructor):
 *
 * | Option             | Default | Description                                    |
 * |--------------------|---------|------------------------------------------------|
 * | failureThreshold   | 5       | In-window failures before opening               |
 * | successThreshold   | 1       | HALF_OPEN probe successes needed to close       |
 * | halfOpenAfterMs    | 30 000  | Time to stay OPEN before probing                |
 * | windowMs           | 60 000  | Rolling failure-window length                   |
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

/** Options accepted by {@link CircuitBreaker} and {@link getCircuitBreaker}. */
export interface CircuitBreakerOptions {
  /**
   * Number of failures within `windowMs` that cause the breaker to open.
   * @default 5
   */
  failureThreshold?: number;
  /**
   * Number of consecutive HALF_OPEN probe successes required before the
   * breaker closes again.
   * @default 1
   */
  successThreshold?: number;
  /**
   * How long the breaker stays OPEN before allowing a HALF_OPEN probe.
   * @default 30_000
   */
  halfOpenAfterMs?: number;
  /**
   * Length of the rolling failure-count window in milliseconds.
   * Failures older than this are discarded.
   * @default 60_000
   */
  windowMs?: number;
  /**
   * @deprecated Legacy alias for {@link CircuitBreakerOptions.halfOpenAfterMs}.
   * Retained for existing callers; `halfOpenAfterMs` wins when both are given.
   */
  resetTimeoutMs?: number;
}

/** Immutable view of a breaker's configuration and live counters. */
export interface CircuitBreakerSnapshot {
  /** Registry name of the breaker. */
  name: string;
  /** Current state, after applying any due OPEN → HALF_OPEN transition. */
  state: CircuitBreakerState;
  /** Failures currently inside the rolling window. */
  failures: number;
  /** Consecutive HALF_OPEN probe successes so far. */
  successes: number;
  /** When the breaker last tripped to OPEN, or `null` if it is closed. */
  openedAt: number | null;
  failureThreshold: number;
  successThreshold: number;
  halfOpenAfterMs: number;
}

/**
 * Thrown by {@link CircuitBreaker.execute} when the breaker is OPEN, or when
 * the single HALF_OPEN probe slot is already occupied. Callers should map this
 * to HTTP 503 and surface `openedAt` / `halfOpenAfterMs` so clients can back
 * off intelligently.
 */
export class CircuitOpenError extends Error {
  public readonly name = "CircuitOpenError";
  /** Registry name of the breaker that rejected the call. */
  public readonly circuitName: string;
  /** When the breaker tripped to OPEN. */
  public readonly openedAt: number;
  /** State the breaker was in when it rejected the call. */
  public readonly state: CircuitBreakerState;

  constructor(
    circuitName: string,
    openedAt: number,
    state?: CircuitBreakerState,
  );
  /**
   * @deprecated Legacy two-argument form that passes the state in second
   * position. `openedAt` defaults to now. Prefer
   * `new CircuitOpenError(name, openedAt, state)`.
   */
  constructor(circuitName: string, state: CircuitBreakerState);
  constructor(
    circuitName: string,
    openedAtOrState: number | CircuitBreakerState,
    state: CircuitBreakerState = "OPEN",
  ) {
    // Discriminate the two supported shapes on the runtime type of the second
    // argument: a number is an `openedAt` timestamp, a string is a state.
    const legacyStateForm = typeof openedAtOrState === "string";
    const resolvedState = legacyStateForm ? openedAtOrState : state;

    super(
      `Circuit breaker '${circuitName}' is ${resolvedState} — downstream call rejected`,
    );
    this.circuitName = circuitName;
    this.openedAt = legacyStateForm ? Date.now() : openedAtOrState;
    this.state = resolvedState;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }

  /** @deprecated Legacy alias for {@link CircuitOpenError.circuitName}. */
  get breakerName(): string {
    return this.circuitName;
  }
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_HALF_OPEN_AFTER_MS = 30_000;
const DEFAULT_WINDOW_MS = 60_000;

// ── CircuitBreaker class ─────────────────────────────────────────────────────

/**
 * Per-endpoint circuit breaker with CLOSED / OPEN / HALF_OPEN state machine.
 *
 * Prefer {@link getCircuitBreaker} over `new CircuitBreaker(...)` so that all
 * callers referring to the same logical downstream share one instance — a
 * breaker only protects a dependency if every caller trips the same counters.
 */
export class CircuitBreaker {
  private readonly _name: string;

  private _failureThreshold = DEFAULT_FAILURE_THRESHOLD;
  private _successThreshold = DEFAULT_SUCCESS_THRESHOLD;
  private _halfOpenAfterMs = DEFAULT_HALF_OPEN_AFTER_MS;
  private _windowMs = DEFAULT_WINDOW_MS;

  private _state: CircuitBreakerState = "CLOSED";
  /** Timestamps (ms since epoch) of recent failures within the rolling window. */
  private failureTimes: number[] = [];
  /** Consecutive HALF_OPEN probe successes accumulated so far. */
  private _successes = 0;
  /** Wall-clock time at which the breaker last tripped to OPEN. */
  private _openedAt: number | null = null;
  /** Guards the single probe slot when HALF_OPEN. */
  private halfOpenProbeInFlight = false;

  constructor(name: string, opts: CircuitBreakerOptions = {}) {
    this._name = name;
    this.configure(opts);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The current state of the circuit breaker. Reading this applies any due
   * OPEN → HALF_OPEN transition, so it is safe to poll.
   */
  get state(): CircuitBreakerState {
    this._maybeTransitionToHalfOpen();
    return this._state;
  }

  /**
   * Apply configuration overrides in place.
   *
   * Only keys that are actually present are applied, so passing a partial
   * object never resets unrelated tuning back to defaults. Called by
   * {@link getCircuitBreaker} so a route can configure the shared breaker it
   * resolves from the registry.
   */
  configure(opts: CircuitBreakerOptions = {}): void {
    if (opts.failureThreshold !== undefined) {
      this._failureThreshold = opts.failureThreshold;
    }
    if (opts.successThreshold !== undefined) {
      this._successThreshold = opts.successThreshold;
    }
    // `halfOpenAfterMs` is the current name; `resetTimeoutMs` is the legacy
    // alias kept for existing callers.
    if (opts.halfOpenAfterMs !== undefined) {
      this._halfOpenAfterMs = opts.halfOpenAfterMs;
    } else if (opts.resetTimeoutMs !== undefined) {
      this._halfOpenAfterMs = opts.resetTimeoutMs;
    }
    if (opts.windowMs !== undefined) {
      this._windowMs = opts.windowMs;
    }
  }

  /**
   * Run the supplied async callable through the breaker.
   *
   * - CLOSED: calls through, recording success/failure.
   * - OPEN: throws {@link CircuitOpenError} immediately (fast-fail) without
   *   invoking `callable` at all.
   * - HALF_OPEN: allows one probe at a time; `successThreshold` successes →
   *   CLOSED, any failure → OPEN. Concurrent callers get a
   *   {@link CircuitOpenError} while a probe is in flight.
   *
   * @param callable  Zero-argument async function wrapping the downstream call.
   * @returns The resolved value of `callable`.
   * @throws  {@link CircuitOpenError} when the breaker is OPEN or the HALF_OPEN
   *          probe slot is busy. A `CircuitOpenError` raised here is *not*
   *          counted as a downstream failure — no call was made.
   * @throws  Whatever `callable` throws when it fails while the breaker is
   *          CLOSED or serving as the HALF_OPEN probe.
   */
  async execute<T>(callable: () => Promise<T>): Promise<T> {
    this._maybeTransitionToHalfOpen();

    if (this._state === "OPEN") {
      logger.warn(
        { circuitName: this._name, state: this._state, openedAt: this._openedAt },
        "circuit_breaker_open_fast_fail",
      );
      throw new CircuitOpenError(
        this._name,
        this._openedAt ?? Date.now(),
        "OPEN",
      );
    }

    // Capture up front: `_state` may change while `callable` is in flight, and
    // only the call that claimed the probe slot may release it.
    const isProbe = this._state === "HALF_OPEN";

    if (isProbe) {
      if (this.halfOpenProbeInFlight) {
        logger.warn(
          { circuitName: this._name, state: this._state },
          "circuit_breaker_half_open_probe_busy",
        );
        throw new CircuitOpenError(
          this._name,
          this._openedAt ?? Date.now(),
          "HALF_OPEN",
        );
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
      if (isProbe) {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  /** @deprecated Legacy alias for {@link CircuitBreaker.execute}. */
  fire<T>(callable: () => Promise<T>): Promise<T> {
    return this.execute(callable);
  }

  /** A point-in-time view of configuration and counters, safe to log or serve. */
  snapshot(): CircuitBreakerSnapshot {
    // Read through the getter so a due OPEN → HALF_OPEN transition is applied.
    const state = this.state;
    return {
      name: this._name,
      state,
      failures: this._prunedFailureCount(),
      successes: this._successes,
      openedAt: this._openedAt,
      failureThreshold: this._failureThreshold,
      successThreshold: this._successThreshold,
      halfOpenAfterMs: this._halfOpenAfterMs,
    };
  }

  /**
   * Reset the breaker to CLOSED and clear all counters. Intended for test
   * suites and operational tooling; the normal recovery path is the HALF_OPEN
   * probe.
   */
  reset(): void {
    this._close();
  }

  /**
   * Force a state, bypassing the state machine. **Test-only** — production
   * code must drive the breaker through {@link CircuitBreaker.execute}.
   */
  forceStateForTests(state: CircuitBreakerState): void {
    this._state = state;
    this._openedAt = state === "CLOSED" ? null : Date.now();
    this._successes = 0;
    this.halfOpenProbeInFlight = false;
    if (state === "CLOSED") {
      this.failureTimes = [];
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Prunes stale timestamps and returns the current in-window failure count. */
  private _prunedFailureCount(): number {
    const cutoff = Date.now() - this._windowMs;
    this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
    return this.failureTimes.length;
  }

  /** Transitions from OPEN to HALF_OPEN once `halfOpenAfterMs` has elapsed. */
  private _maybeTransitionToHalfOpen(): void {
    if (
      this._state === "OPEN" &&
      this._openedAt !== null &&
      Date.now() - this._openedAt >= this._halfOpenAfterMs
    ) {
      this._state = "HALF_OPEN";
      this._successes = 0;
      this.halfOpenProbeInFlight = false;
      logger.info(
        { circuitName: this._name, state: "HALF_OPEN" },
        "circuit_breaker_half_open",
      );
    }
  }

  private _onSuccess(): void {
    if (this._state === "HALF_OPEN") {
      this._successes += 1;
      if (this._successes >= this._successThreshold) {
        this._close();
      } else {
        logger.info(
          {
            circuitName: this._name,
            successes: this._successes,
            successThreshold: this._successThreshold,
          },
          "circuit_breaker_probe_success",
        );
      }
      return;
    }

    // CLOSED — a success clears any accumulated failures.
    this.failureTimes = [];
    this._successes = 0;
  }

  private _onFailure(): void {
    const now = Date.now();

    if (this._state === "HALF_OPEN") {
      // Probe failed — return to OPEN and restart the reset timer.
      this._trip(now);
      logger.warn(
        { circuitName: this._name, state: "OPEN" },
        "circuit_breaker_probe_failed_reopened",
      );
      return;
    }

    // CLOSED — record the failure and check the threshold.
    this.failureTimes.push(now);
    const count = this._prunedFailureCount();

    if (count >= this._failureThreshold) {
      this._trip(now);
      logger.warn(
        {
          circuitName: this._name,
          failures: count,
          threshold: this._failureThreshold,
          openedAt: now,
          state: "OPEN",
        },
        "circuit_breaker_opened",
      );
    }
  }

  /** Trip to OPEN and start the `halfOpenAfterMs` countdown. */
  private _trip(now: number): void {
    this._state = "OPEN";
    this._openedAt = now;
    this._successes = 0;
  }

  /** Return to CLOSED and clear every counter. */
  private _close(): void {
    const wasOpen = this._state !== "CLOSED";
    this._state = "CLOSED";
    this.failureTimes = [];
    this._successes = 0;
    this._openedAt = null;
    this.halfOpenProbeInFlight = false;
    if (wasOpen) {
      logger.info(
        { circuitName: this._name, state: "CLOSED" },
        "circuit_breaker_closed",
      );
    }
  }
}

// ── Global Registry ─────────────────────────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>();

/**
 * Resolve the shared breaker for `name`, creating it on first use.
 *
 * When `opts` is supplied it is applied to the breaker even if it already
 * exists, so a route can express its tuning without having to be the first
 * caller. Only keys present in `opts` are applied.
 */
export function getCircuitBreaker(
  name: string,
  opts?: CircuitBreakerOptions,
): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, opts);
    breakers.set(name, breaker);
  } else if (opts) {
    breaker.configure(opts);
  }
  return breaker;
}

/** Drop every registered breaker. **Test-only.** */
export function resetCircuitBreakersForTests(): void {
  breakers.clear();
}

/**
 * Force a registered breaker into `state`, optionally applying configuration
 * overrides at the same time. **Test-only.**
 */
export function forceCircuitStateForTests(
  name: string,
  state: CircuitBreakerState,
  opts?: CircuitBreakerOptions,
): void {
  getCircuitBreaker(name, opts).forceStateForTests(state);
}
