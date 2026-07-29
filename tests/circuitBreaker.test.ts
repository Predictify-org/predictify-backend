import { CircuitBreaker, CircuitBreakerOpenError, CircuitState } from '../src/lib/circuitBreaker';

describe('CircuitBreaker Unit Tests', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });
  });

  test('starts in CLOSED state and executes successfully', async () => {
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    const result = await cb.execute(async () => 'OK');
    expect(result).toBe('OK');
  });

  test('trips to OPEN after hitting failure threshold and throws 503 fast error', async () => {
    const failFn = async () => { throw new Error('Downstream Error'); };

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(failFn)).rejects.toThrow('Downstream Error');
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Fast fail with CircuitBreakerOpenError
    await expect(cb.execute(async () => 'OK')).rejects.toThrow(CircuitBreakerOpenError);
  });

  test('transitions to HALF_OPEN after timeout and recovers on success', async () => {
    const failFn = async () => { throw new Error('Downstream Error'); };

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(failFn)).rejects.toThrow();
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 550));

    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    const result = await cb.execute(async () => 'RECOVERED');
    expect(result).toBe('RECOVERED');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });
});
