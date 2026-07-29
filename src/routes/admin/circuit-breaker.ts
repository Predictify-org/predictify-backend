/**
 * admin/circuit-breaker.ts
 *
 * POST /api/admin/circuit-breaker
 * PATCH /api/admin/circuit-breaker
 *
 * Toggle indexer and webhook circuit breakers.
 *
 * Security:
 *  - Requires a valid admin JWT (role: "admin") via the requireAdmin middleware.
 *  - Rate-limited to 60 requests per minute per admin token.
 *
 * HTTP status codes:
 *  - 200 OK            breaker state updated or current state returned
 *  - 400 Bad Request   invalid payload
 *  - 403 Forbidden     missing/invalid/non-admin JWT
 *  - 404 Not Found     unknown breaker type
 *  - 409 Conflict      breaker already in requested state
 *  - 422 Unprocessable Entity  validation failed
 *  - 429 Too Many Requests
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAdmin } from "../../middleware/requireAdmin";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";
import {
  listCircuitBreakers,
  setCircuitBreaker,
  CircuitBreakerNotFoundError,
  CircuitBreakerConflictError,
  CircuitBreakerState,
} from "../../services/circuitBreakerService";
import { RouteErrorFactory, toErrorEnvelope } from "../../errors";
import {
  circuitBreakerToggleSchema,
  circuitBreakerMultiToggleSchema,
  type CircuitBreakerToggle,
  type CircuitBreakerMultiToggle,
} from "../../schemas/circuit-breaker.schema";

export interface AdminCircuitBreakerRouterOptions {
  rateLimitPerMinute?: number;
}

function handleBreakerError(
  res: import("express").Response,
  e: unknown,
): boolean {
  if (e instanceof CircuitBreakerNotFoundError) {
    res.status(404).json({
      error: toErrorEnvelope({
        kind: "NotFound",
        message: e.message,
      }, getRequestId()),
    });
    return true;
  }
  if (e instanceof CircuitBreakerConflictError) {
    res.status(409).json({
      error: toErrorEnvelope({
        kind: "Conflict",
        message: e.message,
      }, getRequestId()),
    });
    return true;
  }
  return false;
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
    const breakers = listCircuitBreakers();
    res.json({ data: breakers });
  });

  router.post("/", async (req, res, next) => {
    try {
      const parsed = circuitBreakerToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw RouteErrorFactory.validation(parsed.error.issues[0]?.message ?? "invalid body");
      }
      const input = parsed.data as CircuitBreakerToggle;
      const actor = (req as { adminAddress?: string }).adminAddress ?? "unknown";
      const breaker = setCircuitBreaker(input.type, input.enabled, actor);
      logger.info(
        { reqId: getRequestId(), type: breaker.type, enabled: breaker.enabled, actor },
        "circuit_breaker_toggled",
      );
      return res.json({ data: breaker });
    } catch (e) {
      if (handleBreakerError(res, e)) return;
      return next(e);
    }
  });

  router.patch("/", async (req, res, next) => {
    try {
      const parsed = circuitBreakerMultiToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw RouteErrorFactory.validation(parsed.error.issues[0]?.message ?? "invalid body");
      }
      const input = parsed.data as CircuitBreakerMultiToggle;
      const actor = (req as { adminAddress?: string }).adminAddress ?? "unknown";
      const results: CircuitBreakerState[] = [];

      if (input.indexer !== undefined) {
        results.push(setCircuitBreaker("indexer", input.indexer, actor));
      }
      if (input.webhook !== undefined) {
        results.push(setCircuitBreaker("webhook", input.webhook, actor));
      }

      logger.info(
        { reqId: getRequestId(), toggled: results.map((r) => r.type), actor },
        "circuit_breakers_toggled",
      );
      return res.json({ data: results });
    } catch (e) {
      if (handleBreakerError(res, e)) return;
      return next(e);
    }
  });

  return router;
}

export const adminCircuitBreakerRouter = createAdminCircuitBreakerRouter();