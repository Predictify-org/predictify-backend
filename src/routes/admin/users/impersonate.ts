/**
 * admin/users/impersonate.ts
 *
 * POST /api/admin/users/:address/impersonate
 *
 * Allows an admin to obtain a short-lived access token that impersonates
 * the target Stellar wallet address.
 *
 * Security:
 *  - Requires a valid admin JWT (role: "admin") via requireAdmin middleware.
 *  - Rate-limited to 60 requests per minute per admin token.
 *  - Every call is double-audited: once in the global audit_logs table and
 *    once in the admin_audit_log table keyed by target address.
 *
 * Circuit breaker:
 *  - The downstream work (token signing + audit writes) is wrapped in a
 *    named circuit breaker ("impersonate").
 *  - CLOSED (normal): calls execute and failures are counted.
 *  - OPEN (tripped): the breaker fast-fails immediately with HTTP 503 so
 *    the admin UI / caller gets a clear signal that the downstream is
 *    unhealthy rather than hanging for the full request timeout.
 *  - HALF_OPEN (recovery probe): one trial call is allowed; a success
 *    resets the breaker to CLOSED; a failure keeps it OPEN.
 *
 * HTTP status codes:
 *  - 200 OK            impersonation succeeded; body: { data: { token } }
 *  - 400 Bad Request   address param is blank / whitespace-only
 *  - 403 Forbidden     missing/invalid/non-admin JWT
 *  - 429 Too Many Requests  rate limit exceeded
 *  - 503 Service Unavailable  circuit is OPEN; body: { error: { code: "service_unavailable", retryAfterMs } }
 *    and a `Retry-After` header (seconds) so standard HTTP clients back off.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { signAccessToken } from "../../../services/jwtService";
import { createAuditLog } from "../../../services/auditService";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import { securityHeaders } from "../../../middleware/securityHeaders";
import { db } from "../../../db/client";
import { adminAuditLog } from "../../../db/schema";
import {
  getCircuitBreaker,
  CircuitOpenError,
  type CircuitBreakerOptions,
} from "../../../lib/circuitBreaker";

export interface AdminImpersonateRouterOptions {
  /** Requests per minute per admin token. Default: 60 */
  rateLimitPerMinute?: number;
  /** Circuit breaker configuration for downstream calls. */
  circuitBreaker?: CircuitBreakerOptions;
}

/** Name used to identify the impersonate circuit breaker in logs and snapshots. */
export const IMPERSONATE_CIRCUIT_NAME = "impersonate";

const paramsSchema = z.object({
  address: z.string().trim().min(1),
});

export function createAdminImpersonateRouter(
  opts: AdminImpersonateRouterOptions = {},
): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

  // Resolved from the shared registry so every caller of this endpoint trips
  // the same counters. `opts.circuitBreaker` is applied even if the breaker
  // already exists, so thresholds are honoured regardless of creation order.
  const breaker = getCircuitBreaker(IMPERSONATE_CIRCUIT_NAME, opts.circuitBreaker);

  const impersonateRateLimit = rateLimit({
    windowMs: 60_000,
    limit,
    keyGenerator: (req) =>
      (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
    standardHeaders: "draft-6",
    legacyHeaders: false,
    message: { error: { code: "rate_limit_exceeded" } },
  });

  // Middleware is attached to the route rather than via `router.use` so that
  // mounting this router on the shared /api/admin/users prefix cannot apply
  // this endpoint's rate limit or auth to sibling routers' requests that
  // merely pass through on their way to a later mount.
  router.post(
    "/:address/impersonate",
    securityHeaders,
    impersonateRateLimit,
    requireAdmin,
    async (req, res, next) => {
      const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

      try {
        const parsed = paramsSchema.safeParse(req.params);

        if (!parsed.success) {
          res.status(400).json({
            error: {
              code: "validation_error",
              details: parsed.error.issues,
              requestId: reqId,
            },
          });
          return;
        }

        const targetAddress = parsed.data.address;
        const adminAddress = req.adminAddress!;

        // Wrap all downstream I/O in the circuit breaker.
        // If the breaker is OPEN this throws CircuitOpenError immediately
        // (before any network or DB call is attempted).
        const token = await breaker.execute(async () => {
          // 1. Audit log in global audit_logs
          await createAuditLog({
            action: "admin.impersonate",
            walletAddress: adminAddress,
            ip: req.ip ?? "unknown",
            correlationId: reqId,
            beforeState: null,
            afterState: { targetAddress, role: "user" },
          });

          // 2. Audit log in admin_audit_log keyed by target address
          await db.insert(adminAuditLog).values({
            adminAddress,
            action: "impersonate",
            targetAddress,
          });

          // 3. Structured logging with correlation IDs
          logger.info(
            {
              adminAddress,
              targetAddress,
              correlationId: reqId,
            },
            "Admin impersonated user",
          );

          // 4. Generate the impersonation token
          return signAccessToken({ sub: targetAddress, role: "user" });
        });

        res.status(200).json({ data: { token } });
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          // Report the time actually remaining before a probe is allowed
          // rather than the full window, so a caller that retries late is not
          // told to wait all over again.
          const { halfOpenAfterMs } = breaker.snapshot();
          const elapsed = Date.now() - err.openedAt;
          const retryAfterMs = Math.max(0, halfOpenAfterMs - elapsed);

          logger.warn(
            {
              circuitName: IMPERSONATE_CIRCUIT_NAME,
              state: err.state,
              openedAt: err.openedAt,
              retryAfterMs,
              correlationId: reqId,
              reqId,
            },
            "impersonate_circuit_open",
          );

          // Standard HTTP back-off signal, in seconds, alongside the
          // millisecond precision value in the error envelope.
          res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
          res.status(503).json({
            error: {
              code: "service_unavailable",
              message:
                "Impersonate service is temporarily unavailable. Please retry later.",
              retryAfterMs,
              requestId: reqId,
            },
          });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}

export const adminImpersonateRouter = createAdminImpersonateRouter();
