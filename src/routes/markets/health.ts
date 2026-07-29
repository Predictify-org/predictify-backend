import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import {
  probeAllDependencies,
  computeCompositeStatus,
  type DependencyHealth,
  type CompositeStatus,
} from "../../services/healthProbes";

// ── Injectable dependency interface ──────────────────────────────────────────

export type ProbeFn = () => Promise<DependencyHealth>;

export interface MarketsHealthRouterDeps {
  /**
   * Executes all dependency probes and returns the full health map.
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
 * Creates the /api/markets/health router (v7).
 *
 * @param deps.probeFn  - Override the probe function (tests only).
 *                        Defaults to `probeAllDependencies`.
 */
export function createMarketsHealthRouter(deps: MarketsHealthRouterDeps = {}): Router {
  const probe: ProbeFn = deps.probeFn ?? probeAllDependencies;
  const router = Router();

  /**
   * GET /
   *
   * Runs all dependency probes and returns the health snapshot for markets dependencies.
   */
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
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
        "markets_health_check_complete",
      );

      res.status(httpStatus).json({
        status: composite,
        version: "v7",
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies: health,
      });
    } catch (err) {
      logger.error(
        { correlationId, err, elapsedMs: Date.now() - requestStart },
        "markets_health_probe_threw",
      );
      next(err);
    }
  });

  return router;
}

// ── Default export ────────────────────────────────────────────────────────────

export const marketsHealthRouter = createMarketsHealthRouter();
