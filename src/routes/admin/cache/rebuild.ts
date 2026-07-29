/**
 * admin/cache/rebuild.ts
 *
 * POST /api/admin/rebuild-cache
 *
 * Triggers an immediate eviction of all hot-path cache keys so that the next
 * read for each key fetches fresh data from the database.
 *
 * Hot-path keys currently managed:
 *   - markets:all        (list of all active markets)
 *
 * Security:
 *   - Requires a valid admin JWT (role: "admin") via requireAdmin middleware.
 *   - Rate-limited to 10 requests per minute per admin token to guard against
 *     accidental or malicious cache-stampede attacks.
 *
 * Audit:
 *   - Every successful invocation writes an entry to the audit_logs table via
 *     createAuditLog() with action "cache.rebuild".
 *   - The request ID (correlation ID) is echoed in both the response body and
 *     the X-Request-Id response header.
 *
 * HTTP responses:
 *   201  Cache rebuild triggered successfully; body contains evicted key list.
 *   403  Missing, expired, or non-admin JWT.
 *   429  Rate limit exceeded.
 *   500  Redis or audit-log write failure (error envelope returned).
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { rebuildCache } from "../../../cache/marketsCache";
import { createAuditLog } from "../../../services/auditService";
import { REQUEST_ID_HEADER } from "../../../lib/http";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdminCacheRebuildRouterOptions {
  /**
   * Maximum requests per minute per admin token.
   * Default: 10  (deliberately low – cache busts are expensive)
   */
  rateLimitPerMinute?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the request ID from the ALS context first, then fall back to the
 * raw pino-http req.id cast.
 */
function requestIdOf(req: { id?: unknown }): string {
  return (
    getRequestId() ??
    (typeof req.id === "string" ? req.id : String(req.id ?? ""))
  );
}

/**
 * Return the first non-loopback IP from X-Forwarded-For, or req.ip.
 */
function clientIpOf(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return fwd[0]!;
  }
  return req.ip ?? "unknown";
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createAdminCacheRebuildRouter(
  opts: AdminCacheRebuildRouterOptions = {},
): Router {
  const router = Router();
  const ratePerMinute = opts.rateLimitPerMinute ?? 10;

  // ── Rate limiter ─────────────────────────────────────────────────────────
  // Key on the Authorization header value so each distinct admin token gets
  // its own bucket. Falls back to IP so unauthenticated callers are still
  // throttled before reaching requireAdmin.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: ratePerMinute,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ??
        req.ip ??
        "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ──────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── POST / ───────────────────────────────────────────────────────────────
  /**
   * @openapi
   * /api/admin/rebuild-cache:
   *   post:
   *     summary: Rebuild hot-path caches
   *     description: >
   *       Evicts all hot-path Redis cache keys so subsequent reads return fresh
   *       data from the database. Should be used after bulk imports or when
   *       stale data is suspected.
   *     tags:
   *       - Admin / Cache
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       201:
   *         description: Cache rebuild triggered
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: object
   *                   properties:
   *                     evictedKeys:
   *                       type: array
   *                       items:
   *                         type: string
   *                     requestId:
   *                       type: string
   *       403:
   *         description: Forbidden – missing or non-admin JWT
   *       429:
   *         description: Rate limit exceeded
   *       500:
   *         description: Internal server error
   */
  router.post("/", async (req, res, next) => {
    const requestId = requestIdOf(req as { id?: unknown });

    // Echo the correlation ID immediately so clients can correlate logs even
    // if the handler throws later.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    try {
      logger.info(
        {
          event: "cache.rebuild.started",
          requestId,
          adminAddress: req.adminAddress,
        },
        "Admin cache rebuild initiated",
      );

      // ── Evict hot-path keys ──────────────────────────────────────────────
      const { evictedKeys } = await rebuildCache();

      // ── Audit log ────────────────────────────────────────────────────────
      await createAuditLog({
        action: "cache.rebuild",
        walletAddress: req.adminAddress,
        ip: clientIpOf(req as Parameters<typeof clientIpOf>[0]),
        correlationId: requestId,
      });

      logger.info(
        {
          event: "cache.rebuild.completed",
          requestId,
          adminAddress: req.adminAddress,
          evictedKeys,
        },
        "Admin cache rebuild completed",
      );

      res.status(201).json({
        data: {
          evictedKeys,
          requestId,
        },
      });
    } catch (err) {
      logger.error(
        {
          event: "cache.rebuild.failed",
          requestId,
          adminAddress: req.adminAddress,
          err,
        },
        "Admin cache rebuild failed",
      );
      next(err);
    }
  });

  return router;
}

// Default singleton wired into src/index.ts
export const adminCacheRebuildRouter = createAdminCacheRebuildRouter();
