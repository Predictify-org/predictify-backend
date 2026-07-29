import { Router, Request, Response, NextFunction } from 'express';
import { CircuitBreaker, CircuitBreakerOpenError } from '../lib/circuitBreaker';

export const fingerprintCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 10000,
});

export const router = Router();

async function callDownstreamFingerprintService(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Simulates downstream request execution
  return { status: 'success', fingerprintId: 'fp_' + Date.now(), ...data };
}

router.post('/api/fingerprint', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await fingerprintCircuitBreaker.execute(() =>
      callDownstreamFingerprintService(req.body)
    );
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Fingerprint service is temporarily unavailable. Circuit breaker open.',
        },
      });
      return;
    }
    next(error);
  }
});

export default router;
