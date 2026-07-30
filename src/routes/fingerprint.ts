import { Router, type Request, type Response, type NextFunction } from "express";
import { fingerprintCircuitBreaker, CircuitBreakerOpenError } from "../lib/circuitBreaker";

export const fingerprintRouter = Router();
let inFlightFingerprintRequests = 0;

export async function drainFingerprintRequests(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (inFlightFingerprintRequests > 0 && Date.now() - start <= timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function trackFingerprintRequest(_req: Request, res: Response, next: NextFunction): void {
  inFlightFingerprintRequests += 1;
  let finished = false;
  const cleanup = () => {
    if (!finished) {
      finished = true;
      inFlightFingerprintRequests = Math.max(0, inFlightFingerprintRequests - 1);
    }
  };
  res.once("finish", cleanup);
  res.once("close", cleanup);
  next();
}

fingerprintRouter.use(trackFingerprintRequest);

/**
 * Downstream service simulation / call handler
 */
async function callDownstreamFingerprintService(_data: unknown): Promise<{
  fingerprintId: string;
  verified: boolean;
}> {
  // Simulates downstream API interaction
  return { fingerprintId: 'fp_' + Date.now(), verified: true };
}

/**
 * POST /api/fingerprint
 */
fingerprintRouter.post("/", async (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    const statusCode = error instanceof Error && "statusCode" in error
      ? (error as Error & { statusCode?: number }).statusCode
      : undefined;
    if (error instanceof CircuitBreakerOpenError || statusCode === 503) {
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
        message: error instanceof Error ? error.message : 'An unexpected error occurred.',
        correlationId,
      },
    });
  }
});

export default fingerprintRouter;
