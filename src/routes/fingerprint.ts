/**
 * fingerprint.ts
 *
 * GET /api/fingerprint
 *
 * Exposes the stable SHA-256 request fingerprint for the calling client.
 * The fingerprint captures the structural identity of the request — method,
 * path, headers, and body hash — enabling forensic correlation, retry
 * detection, and audit-log enrichment.
 *
 * Response shape
 * ──────────────
 * {
 *   "fingerprint":    "<64-char hex SHA-256>",
 *   "correlationId":  "<uuid>",
 *   "method":         "GET",
 *   "path":           "/api/fingerprint",
 *   "computedAt":     "<ISO-8601>"
 * }
 *
 * Headers
 * ───────
 *   X-Request-Fingerprint  → the computed fingerprint
 *   X-Correlation-Id       → correlation ID for distributed tracing
 *   X-Request-Id           → per-request unique ID
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { buildFingerprintInputs, computeFingerprint } from "../middleware/fingerprint";
import { fingerprintRateLimiter } from "../middleware/rateLimit";
import { getCorrelationId } from "../middleware/correlation";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

// In-flight request tracking for graceful shutdown drain
let inFlightFingerprintRequests = 0;

export async function drainFingerprintRequests(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  if (inFlightFingerprintRequests === 0) {
    logger.info("No in-flight /api/fingerprint requests to drain");
    return;
  }

  logger.info({ inFlight: inFlightFingerprintRequests }, "Draining in-flight /api/fingerprint requests...");

  while (inFlightFingerprintRequests > 0) {
    if (Date.now() - start > timeoutMs) {
      logger.warn({ inFlight: inFlightFingerprintRequests }, "Timeout waiting for /api/fingerprint requests to drain");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (inFlightFingerprintRequests === 0) {
    logger.info("Successfully drained all /api/fingerprint requests");
  }
}

export const fingerprintRouter = Router();

/**
 * GET /
 *
 * Computes and returns the request fingerprint along with the correlation
 * ID so callers can verify their fingerprint and correlate it with
 * distributed traces.
 */
fingerprintRouter.get(
  "/",
  fingerprintRateLimiter,
  (req: Request, res: Response, next: NextFunction): void => {
    inFlightFingerprintRequests++;
    const correlationId = getCorrelationId() ?? "unknown";
    const reqId = getRequestId() ?? "unknown";

    try {
      const inputs = buildFingerprintInputs(req);
      const fingerprint = computeFingerprint(inputs);

      logger.info(
        {
          reqId,
          correlationId,
          fingerprint,
          method: inputs.method,
          path: inputs.path,
        },
        "fingerprint_route_accessed",
      );

      res.status(200).json({
        fingerprint,
        correlationId,
        method: inputs.method,
        path: inputs.path,
        computedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(
        { reqId, correlationId, err },
        "fingerprint_route_error",
      );
      next(err);
    } finally {
      inFlightFingerprintRequests--;
    }
  },
);
