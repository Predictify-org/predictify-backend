import { CircuitBreaker, CircuitState, CircuitBreakerOpenError } from '../src/lib/circuitBreaker';

describe('CircuitBreaker Unit Tests', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 2, cooldownPeriodMs: 100 });
  });

  it('should execute successfully in CLOSED state', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await breaker.execute(fn);
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should open breaker after reaching failure threshold', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Downstream failure'));

    await expect(breaker.execute(fn)).rejects.toThrow();
    await expect(breaker.execute(fn)).rejects.toThrow();

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Should fail fast with 503 CircuitBreakerOpenError without calling inner fn
    await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
  });
});
