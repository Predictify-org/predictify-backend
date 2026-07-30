import { Router, Request, Response } from 'express';
import { fingerprintCircuitBreaker, CircuitBreakerOpenError } from '../lib/circuitBreaker';

const router = Router();

/**
 * Downstream service simulation / call handler
 */
async function callDownstreamFingerprintService(data: any): Promise<any> {
  // Simulates downstream API interaction
  return { fingerprintId: 'fp_' + Date.now(), verified: true };
}

/**
 * POST /api/fingerprint
 */
router.post('/fingerprint', async (req: Request, res: Response) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `req-${Date.now()}`;

  try {
    const result = await fingerprintCircuitBreaker.execute(() =>
      callDownstreamFingerprintService(req.body)
    );

    return res.status(200).json({
      success: true,
      data: result,
      correlationId,
    });
  } catch (error: any) {
    if (error instanceof CircuitBreakerOpenError || error.statusCode === 503) {
      return res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Downstream fingerprint service is currently unavailable. Circuit breaker open.',
          correlationId,
        },
      });
    }

    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message || 'An unexpected error occurred.',
        correlationId,
      },
    });
  }
});

export default router;
