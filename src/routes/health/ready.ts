/**
 * health/ready.ts
 *
 * GET /api/health/ready — deep readiness check
 *
 * Probes all four runtime dependencies in parallel:
 *  1. db          — Postgres (SELECT 1)
 *  2. sorobanRpc  — Soroban RPC (getLatestLedger)
 *  3. indexerLag  — compares indexer cursor to chain tip
 *  4. queue       — Redis / BullMQ (PING)
 *
 * HTTP response codes
 * ───────────────────
 *  200 OK                  — all probes pass ("ready")
 *  503 Service Unavailable — one or more probes fail ("unready")
 *
 * Response shape
 * ──────────────
 * {
 *   "status":       "ready" | "unready",
 *   "correlationId": "<uuid>",
 *   "checkedAt":     "<ISO-8601>",
 *   "checks": {
 *     "db":         { "status": "pass"|"fail", "durationMs": <n>, "message": "…" },
 *     "sorobanRpc": { … },
 *     "indexerLag": { … },
 *     "queue":      { … }
 *   }
 * }
 *
 * Security
 * ────────
 * No authentication required — the endpoint returns no sensitive data and is
 * intended for Kubernetes liveness/readiness probes and load-balancer checks.
 * In production, restrict access to internal network paths at the infra level.
 *
 * The response is NOT cached (unlike /healthz/dependencies) because readiness
 * probes are used by orchestrators that need a fresh signal on every poll.
 *
 * Structured logging
 * ──────────────────
 * Each request logs at INFO level with:
 *  - correlationId (from x-correlation-id header or generated UUID)
 *  - overall status
 *  - per-probe results
 *  - total elapsed time
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import {
  performReadinessCheck,
  type DbLike,
  type RedisLike,
} from "../../services/readinessService";

// ── Injectable dependencies ───────────────────────────────────────────────────

export interface ReadyRouterDeps {
  /** Drizzle DB instance (or compatible test stub). */
  db: DbLike;
  /** IORedis connection used by BullMQ (or compatible test stub). */
  redis: RedisLike;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the ready-check router with injected dependencies.
 *
 * Accepting deps as a parameter makes the router fully testable without
 * touching real infrastructure.
 */
export function createReadyRouter(deps: ReadyRouterDeps): Router {
  const router = Router();

  /**
   * GET /
   *
   * Runs all probes and returns 200 when ready, 503 when unready.
   */
  router.get("/", async (req: Request, res: Response, next) => {
    const correlationId =
      (req.headers["x-correlation-id"] as string | undefined)?.trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const result = await performReadinessCheck(deps.db, deps.redis);

      const httpStatus = result.status === "ready" ? 200 : 503;

      logger.info(
        {
          correlationId,
          status: result.status,
          checks: result.checks,
          elapsedMs: Date.now() - requestStart,
        },
        "health_ready_check_complete",
      );

      res.status(httpStatus).json({
        status: result.status,
        correlationId,
        checkedAt: new Date().toISOString(),
        checks: result.checks,
      });
    } catch (err) {
      // Unexpected error — propagate to the global error handler.
      next(err);
    }
  });

  return router;
}
