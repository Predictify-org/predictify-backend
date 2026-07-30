/**
 * src/routes/reports.ts
 *
 * Parent router for all report-related endpoints at /api/reports.
 *
 * Applies per-user token-bucket rate limiting to every sub-route so that
 * future report endpoints inherit throttling automatically.
 *
 * Sub-routes
 * ──────────
 * /api/reports/scheduled   — CRUD for user-owned scheduled report configs
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { createPerUserTokenBucketLimiter } from "../middleware/rateLimit";
import { scheduledReportsRouter } from "./reports/scheduled";
import { idempotency } from "../middleware/idempotency";

let inFlightReportsRequests = 0;

/** Wait for report handlers to finish before the database is closed. */
export async function drainReportsRequests(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (inFlightReportsRequests > 0 && Date.now() - start <= timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Track all requests entering /api/reports, including auth failures. */
export function reportsInFlightMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  inFlightReportsRequests += 1;
  let finished = false;
  const cleanup = () => {
    if (!finished) {
      finished = true;
      inFlightReportsRequests = Math.max(0, inFlightReportsRequests - 1);
    }
  };

  res.once("finish", cleanup);
  res.once("close", cleanup);
  next();
}

export interface ReportsRouterOptions {
  rateLimit?: {
    capacity?: number;
    refillWindowMs?: number;
  };
}

export function createReportsRouter(options: ReportsRouterOptions = {}): Router {
  const router = Router();

  router.use(reportsInFlightMiddleware);
  router.use(requireAuth);
  router.use(
    createPerUserTokenBucketLimiter({
      capacity: options.rateLimit?.capacity ?? 60,
      refillWindowMs: options.rateLimit?.refillWindowMs ?? 60 * 1000,
    }),
  );

  const mutationMethods = ["POST", "PATCH"];
  router.use((req, res, next) =>
    mutationMethods.includes(req.method) ? idempotency(req, res, next) : next()
  );

  router.use("/scheduled", scheduledReportsRouter);

  return router;
}

export const reportsRouter = createReportsRouter();
