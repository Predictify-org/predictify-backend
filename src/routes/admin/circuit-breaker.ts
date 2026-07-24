/**
 * Admin circuit breaker router.
 *
 *   GET    /api/admin/circuit-breaker        — list all breakers (indexer, webhook)
 *   PATCH  /api/admin/circuit-breaker/:type  — toggle a breaker
 *
 * Every route requires a valid admin JWT (role: "admin"). Requests are
 * rate-limited per admin token. Input is validated at the boundary with zod and
 * all failures return the standard error envelope.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";
import {
  getAllCircuitBreakers,
  setCircuitBreaker,
  resetCircuitBreakersForTests,
  CircuitBreakerState,
  CircuitType,
} from "../../services/circuitBreakerService";

export interface AdminCircuitBreakerRouterOptions {
  rateLimitPerMinute?: number;
}

const circuitTypeSchema = z.enum(["indexer", "webhook"]);

const toggleSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

function validationError(res: import("express").Response, message: string): void {
  res.status(400).json({
    error: { code: "validation_error", message, requestId: getRequestId() },
  });
}

export function createAdminCircuitBreakerRouter(
  opts: AdminCircuitBreakerRouterOptions = {},
): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  router.use(requireAdmin);

  router.get("/", (_req, res) => {
    res.json({ data: getAllCircuitBreakers() });
  });

  router.patch("/:type", (req, res, next) => {
    const type = circuitTypeSchema.safeParse(req.params.type);
    if (!type.success) {
      return validationError(res, "invalid circuit breaker type");
    }

    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed.error.issues[0]?.message ?? "invalid body");
    }

    const { enabled } = parsed.data;
    const actor = req.adminAddress ?? "unknown";

    try {
      const breaker = setCircuitBreaker(type.data, enabled, actor);
      logger.info({ reqId: getRequestId(), type: type.data, enabled, actor }, "circuit_breaker_toggled");
      return res.json({ data: breaker });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}

export const adminCircuitBreakerRouter = createAdminCircuitBreakerRouter();
export { resetCircuitBreakersForTests };
export type { CircuitBreakerState, CircuitType };