/**
 * src/routes/exports.ts
 *
 * Parent router for all export-related endpoints at /api/exports.
 *
 * Applies authentication and per-user token-bucket rate limiting to every
 * export sub-route. Supports Idempotency-Key handling on mutations (POST/PATCH).
 *
 * Sub-routes:
 * ──────────
 * /api/exports/predictions — Prediction history data export (CSV or JSON)
 * /api/exports             — Prediction history export (default alias)
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { createPerUserTokenBucketLimiter } from "../middleware/rateLimit";
import { exportsPredictionsRouter } from "./exports/predictions";
import { env } from "../config/env";
import { logger } from "../config/logger";

// In-flight request tracking for graceful shutdown drain
let inFlightExportsRequests = 0;

/**
 * Wait for all in-flight /api/exports requests to finish.
 * @param timeoutMs Maximum time to wait before forcing resolution
 */
export async function drainExportsRequests(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  if (inFlightExportsRequests === 0) {
    logger.info("No in-flight /api/exports requests to drain");
    return;
  }

  logger.info({ inFlight: inFlightExportsRequests }, "Draining in-flight /api/exports requests...");

  while (inFlightExportsRequests > 0) {
    if (Date.now() - start > timeoutMs) {
      logger.warn({ inFlight: inFlightExportsRequests }, "Timeout waiting for /api/exports requests to drain");
      break;
    }
    // Poll every 50ms
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (inFlightExportsRequests === 0) {
    logger.info("Successfully drained all /api/exports requests");
  }
}

function exportsInFlightMiddleware(_req: Request, res: Response, next: NextFunction): void {
  inFlightExportsRequests++;
  let finished = false;
  const cleanup = () => {
    if (!finished) {
      finished = true;
      inFlightExportsRequests = Math.max(0, inFlightExportsRequests - 1);
    }
  };

  res.once("finish", cleanup);
  res.once("close", cleanup);
  next();
}

export interface ExportsRouterOptions {
  rateLimit?: {
    capacity?: number;
    refillWindowMs?: number;
  };
}

export function createExportsRouter(options: ExportsRouterOptions = {}): Router {
  const router = Router();

  router.use(exportsInFlightMiddleware);
  router.use(requireAuth);
  router.use(
    createPerUserTokenBucketLimiter({
      capacity: options.rateLimit?.capacity ?? env.EXPORTS_RATE_LIMIT_CAPACITY,
      refillWindowMs: options.rateLimit?.refillWindowMs ?? env.EXPORTS_RATE_LIMIT_WINDOW_MS,
    }),
  );

  router.use("/predictions", exportsPredictionsRouter);
  router.use("/", exportsPredictionsRouter);

  return router;
}

export const exportsRouter = createExportsRouter();
