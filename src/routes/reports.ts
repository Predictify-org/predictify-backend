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

import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { createPerUserTokenBucketLimiter } from "../middleware/rateLimit";
import { scheduledReportsRouter } from "./reports/scheduled";

export interface ReportsRouterOptions {
  rateLimit?: {
    capacity?: number;
    refillWindowMs?: number;
  };
}

export function createReportsRouter(options: ReportsRouterOptions = {}): Router {
  const router = Router();

  router.use(requireAuth);
  router.use(
    createPerUserTokenBucketLimiter({
      capacity: options.rateLimit?.capacity ?? 60,
      refillWindowMs: options.rateLimit?.refillWindowMs ?? 60 * 1000,
    }),
  );

  router.use("/scheduled", scheduledReportsRouter);

  return router;
}

export const reportsRouter = createReportsRouter();
