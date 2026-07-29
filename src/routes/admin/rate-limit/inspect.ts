/**
 * Admin rate-limit inspect router.
 *
 * GET /api/admin/rate-limit/inspect/:address
 *
 * Returns the current rate-limit usage for a target Stellar address.
 * The endpoint is admin-only and rate-limited per admin token.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { SlidingWindowStore } from "../../../middleware/rateLimitAnon";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";

export interface AdminRateLimitInspectRouterOptions {
  /** Requests per minute per admin token. Default: 60 */
  rateLimitPerMinute?: number;
  /** Sliding window length in milliseconds. Default: 60_000 */
  windowMs?: number;
  /** Max requests in the window. Default: 60 */
  max?: number;
  /** Store used to track per-address usage. */
  store?: SlidingWindowStore;
}

const stellarAddressSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

function validationError(res: import("express").Response, message: string): void {
  res.status(400).json({
    error: { code: "validation_error", message, requestId: getRequestId() },
  });
}

export function createAdminRateLimitInspectRouter(
  opts: AdminRateLimitInspectRouterOptions = {},
): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const store = opts.store ?? new SlidingWindowStore();

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

  router.get("/inspect/:address", (req, res) => {
    const parsed = stellarAddressSchema.safeParse(req.params.address);
    if (!parsed.success) {
      return validationError(res, parsed.error.issues[0]?.message ?? "invalid stellar address");
    }

    const now = Date.now();
    const active = store.getTimestamps(parsed.data, now, windowMs);
    const used = active.length;
    const remaining = Math.max(0, max - used);
    const resetAt =
      used > 0 ? new Date(active[0]! + windowMs).toISOString() : new Date(now + windowMs).toISOString();

    logger.info(
      {
        reqId: getRequestId(),
        actor: req.adminAddress,
        address: parsed.data,
        used,
        remaining,
        windowMs,
        max,
      },
      "admin_rate_limit_inspect",
    );

    return res.json({
      data: {
        address: parsed.data,
        limit: max,
        used,
        remaining,
        windowMs,
        resetAt,
      },
    });
  });

  return router;
}

export const adminRateLimitInspectStore = new SlidingWindowStore();

export const adminRateLimitInspectRouter = createAdminRateLimitInspectRouter();
