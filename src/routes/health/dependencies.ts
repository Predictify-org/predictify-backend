/**
 * health/dependencies.ts
 *
 * GET /api/health/dependencies
 *
 * Probes all external dependencies (Postgres, Soroban RPC, Horizon, webhook
 * queue/Redis) and returns a per-system health snapshot with a composite
 * status code.
 *
 * This endpoint complements the existing probes:
 *  • GET /health                 — process liveness (instant, no I/O)
 *  • GET /healthz/dependencies   — shallow cached probe (5-second TTL)
 *  • GET /api/health/ready       — deep readiness for orchestrators
 *  • GET /api/health/dependencies — this file; uncached, injectable, full detail
 *
 * Response codes
 * ──────────────
 *  200 OK           — all four probes pass ("ok")
 *  207 Multi-Status — at least one probe is degraded but none are down
 *  503 Unavailable  — at least one probe is down
 *
 * Response shape
 * ──────────────
 * {
 *   "status":        "ok" | "degraded" | "down",
 *   "correlationId": "<uuid>",
 *   "checkedAt":     "<ISO-8601>",
 *   "dependencies": {
 *     "postgres":     { "status": "ok"|"degraded"|"down", "latencyMs": <n>, "error?": "…" },
 *     "sorobanRpc":   { … },
 *     "horizon":      { … },
 *     "webhookQueue": { … }
 *   }
 * }
 *
 * Security
 * ────────
 * No authentication required — the response contains no sensitive data.
 * In production, restrict access at the infrastructure level (internal ALB,
 * VPC-only routing, etc.).
 *
 * The response is NOT cached here (unlike /healthz/dependencies). Callers
 * that want caching should use the lower-level getCachedDependencyHealth()
 * directly or add a cache layer in front of this endpoint.
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in the `DependenciesRouterDeps.probeFn`
 * callback so tests can substitute a fully-controlled stub without touching
 * real infrastructure.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import {
  probeAllDependencies,
  computeCompositeStatus,
  type DependencyHealth,
  type CompositeStatus,
} from "../../services/healthProbes";

// ── Injectable dependency interface ──────────────────────────────────────────

/**
 * Signature of the probe function injected into the router.
 * Production code passes `probeAllDependencies`; tests pass a stub.
 */
export type ProbeFn = () => Promise<DependencyHealth>;

export interface DependenciesRouterDeps {
  /**
   * Executes all four dependency probes and returns the full health map.
   * Defaults to the production `probeAllDependencies` implementation.
   */
  probeFn?: ProbeFn;
}

// ── HTTP status mapping ───────────────────────────────────────────────────────

function compositeToHttpStatus(composite: CompositeStatus): number {
  if (composite === "ok") return 200;
  if (composite === "degraded") return 207;
  return 503;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the /api/health/dependencies router.
 *
 * @param deps.probeFn  - Override the probe function (tests only).
 *                        Defaults to `probeAllDependencies`.
 */
export function createDependenciesRouter(deps: DependenciesRouterDeps = {}): Router {
  const probe: ProbeFn = deps.probeFn ?? probeAllDependencies;
  const router = Router();

  /**
   * GET /
   *
   * Runs all dependency probes and returns the health snapshot.
   */
  router.get("/", async (req: Request, res: Response, next) => {
    // Honour an inbound x-correlation-id if present; otherwise generate one.
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const health = await probe();
      const composite = computeCompositeStatus(health);
      const httpStatus = compositeToHttpStatus(composite);

      logger.info(
        {
          correlationId,
          status: composite,
          httpStatus,
          elapsedMs: Date.now() - requestStart,
          postgres: health.postgres.status,
          sorobanRpc: health.sorobanRpc.status,
          horizon: health.horizon.status,
          webhookQueue: health.webhookQueue.status,
        },
        "health_dependencies_check_complete",
      );

      res.status(httpStatus).json({
        status: composite,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies: health,
      });
    } catch (err) {
      // Unexpected error — propagate to the global error handler so the
      // standard error envelope is returned.
      logger.error(
        { correlationId, err, elapsedMs: Date.now() - requestStart },
        "health_dependencies_probe_threw",
      );
      next(err);
    }
  });

  return router;
}

// ── Default export ────────────────────────────────────────────────────────────

/** Production router instance wired into src/index.ts. */
export const dependenciesRouter = createDependenciesRouter();
