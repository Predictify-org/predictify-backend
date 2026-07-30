export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Number of failures before opening
  cooldownPeriodMs?: number; // Time in ms before attempting half-open
}

export class CircuitBreakerOpenError extends Error {
  public statusCode: number = 503;
  constructor(message: string = 'Service unavailable: Circuit breaker is OPEN') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }

  /** @deprecated Legacy alias for {@link CircuitOpenError.circuitName}. */
  get breakerName(): string {
    return this.circuitName;
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastStateChange: number = Date.now();
  private readonly failureThreshold: number;
  private readonly cooldownPeriodMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownPeriodMs = options.cooldownPeriodMs ?? 30000; // Default 30 seconds
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastStateChange >= this.cooldownPeriodMs) {
        this.state = CircuitState.HALF_OPEN;
      }
    }
    return this.state;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold || this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      this.lastStateChange = Date.now();
    }
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
  }
}

// Global/Per-endpoint instances
export const fingerprintCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownPeriodMs: 15000,
});
