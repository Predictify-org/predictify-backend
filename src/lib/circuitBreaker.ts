export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  /** Compatibility alias for the rolling failure window. */
  windowMs?: number;
  /** Compatibility alias for the OPEN → HALF_OPEN delay. */
  resetTimeoutMs?: number;
  cooldownPeriodMs?: number;
}

export class CircuitOpenError extends Error {
  readonly statusCode = 503;
  readonly breakerName: string;
  readonly circuitName: string;
  readonly state: CircuitState;
  readonly openedAt: number;
  readonly halfOpenAfterMs: number;

  constructor(
    breakerName: string,
    state: CircuitState,
    openedAt = Date.now(),
    halfOpenAfterMs = 30_000,
  ) {
    super(`Circuit breaker '${breakerName}' is ${state}`);
    this.name = "CircuitOpenError";
    this.breakerName = breakerName;
    this.circuitName = breakerName;
    this.state = state;
    this.openedAt = openedAt;
    this.halfOpenAfterMs = halfOpenAfterMs;
  }
}

/** Backwards-compatible name used by the fingerprint endpoint. */
export class CircuitBreakerOpenError extends CircuitOpenError {
  constructor(breakerName = "fingerprint", state = CircuitState.OPEN) {
    super(breakerName, state);
    this.name = "CircuitBreakerOpenError";
  }
}

export class CircuitBreaker {
  private currentState = CircuitState.CLOSED;
  private failures: number[] = [];
  private openedAt = 0;
  private halfOpenProbeInFlight = false;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly resetTimeoutMs: number;

  constructor(
    nameOrOptions: string | CircuitBreakerOptions = {},
    maybeOptions: CircuitBreakerOptions = {},
  ) {
    this.name = typeof nameOrOptions === "string" ? nameOrOptions : "circuit";
    const options = typeof nameOrOptions === "string" ? maybeOptions : nameOrOptions;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.resetTimeoutMs = options.resetTimeoutMs ?? options.cooldownPeriodMs ?? 30_000;
  }

  readonly name: string;

  get state(): CircuitState {
    return this.getState();
  }

  public getState(): CircuitState {
    if (
      this.currentState === CircuitState.OPEN &&
      Date.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      this.currentState = CircuitState.HALF_OPEN;
    }
    return this.currentState;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.fire(fn);
  }

  public async fire<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === CircuitState.OPEN || (state === CircuitState.HALF_OPEN && this.halfOpenProbeInFlight)) {
      throw new CircuitBreakerOpenError(this.name, state);
    }

    if (state === CircuitState.HALF_OPEN) {
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await fn();
      this.currentState = CircuitState.CLOSED;
      this.failures = [];
      return result;
    } catch (error) {
      this.recordFailure(state);
      throw error;
    } finally {
      if (state === CircuitState.HALF_OPEN) {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  private recordFailure(state: CircuitState): void {
    if (state === CircuitState.HALF_OPEN) {
      this.open();
      return;
    }

    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((timestamp) => timestamp >= cutoff);
    this.failures.push(Date.now());
    if (this.failures.length >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.currentState = CircuitState.OPEN;
    this.openedAt = Date.now();
  }

  public reset(): void {
    this.currentState = CircuitState.CLOSED;
    this.failures = [];
    this.openedAt = 0;
    this.halfOpenProbeInFlight = false;
  }

  public snapshot(): {
    state: CircuitState;
    breakerName: string;
    circuitName: string;
    openedAt: number;
    halfOpenAfterMs: number;
  } {
    return {
      state: this.getState(),
      breakerName: this.name,
      circuitName: this.name,
      openedAt: this.openedAt,
      halfOpenAfterMs: this.resetTimeoutMs,
    };
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(
  name: string,
  options: CircuitBreakerOptions = {},
): CircuitBreaker {
  const existing = breakers.get(name);
  if (existing) return existing;
  const breaker = new CircuitBreaker(name, options);
  breakers.set(name, breaker);
  return breaker;
}

export const fingerprintCircuitBreaker = getCircuitBreaker("fingerprint", {
  failureThreshold: 3,
  cooldownPeriodMs: 15_000,
});
