/**
 * Admin sample-market seed router — NON-PRODUCTION ONLY.
 *
 *   POST /api/admin/seed   → insert a small, fixed batch of sample markets
 *                            (idempotent) for E2E tests and demos.
 *
 * Security layers (outermost first):
 *   1. Production guard — in production the endpoint behaves as if it does not
 *      exist (404). This runs BEFORE auth so the route is not even probeable.
 *   2. Rate limit — 30 requests/min, keyed per admin token (IP fallback).
 *   3. requireAdmin — valid admin JWT required (403 otherwise).
 *
 * The seed itself is idempotent (see src/services/seedService.ts): repeat calls
 * insert nothing and report the existing rows as "skipped".
 */

import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env";
import { requireAdmin } from "../../middleware/requireAdmin";
import { seedSampleMarkets, SeedNotAllowedError } from "../../services/seedService";

/** Pulls the first valid IP from X-Forwarded-For or falls back to socket/ip. */
function extractClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]!;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function requestIdOf(req: { id?: unknown }): string {
  return typeof req.id === "string" ? req.id : "";
}

// The seed endpoint takes no parameters. `.strict()` rejects any unexpected
// fields at the boundary so callers get a clear validation error rather than a
// silently-ignored payload.
const bodySchema = z.object({}).strict();

export interface AdminSeedRouterOptions {
  /** Requests per minute per admin token. Default: 30 */
  rateLimitPerMinute?: number;
}

export function createAdminSeedRouter(opts: AdminSeedRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 30;

  // 1. Production guard — hide the endpoint entirely outside non-prod.
  router.use((req, res, next) => {
    if (env.NODE_ENV === "production") {
      res
        .status(404)
        .json({ error: { code: "not_found", requestId: requestIdOf({ id: req.id }) } });
      return;
    }
    next();
  });

  // 2. Per-admin-token rate limit (IP fallback for unauthenticated callers).
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

  // 3. Admin guard.
  router.use(requireAdmin);

  router.post("/", async (req: Request, res: Response, next) => {
    const requestId = requestIdOf({ id: req.id });

    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          details: parsed.error.issues,
          requestId,
        },
      });
      return;
    }

    if (!req.adminAddress) {
      // requireAdmin guarantees this; narrow defensively for direct callers.
      res.status(401).json({ error: { code: "unauthorized", requestId } });
      return;
    }

    try {
      const result = await seedSampleMarkets({
        adminAddress: req.adminAddress,
        ip: extractClientIp(req),
        correlationId: requestId,
      });
      res.status(200).json({ data: result });
    } catch (err) {
      if (err instanceof SeedNotAllowedError) {
        res.status(err.status).json({
          error: { code: err.code, message: err.message, requestId },
        });
        return;
      }
      next(err);
    }
  });

  return router;
}

// Default export wired into src/index.ts.
export const adminSeedRouter = createAdminSeedRouter();
