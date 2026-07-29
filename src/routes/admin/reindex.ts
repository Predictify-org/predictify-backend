/**
 * Admin reindex endpoint.
 *
 *   POST /api/admin/reindex
 *
 * Triggers a backfill of on-chain Soroban events from a caller-supplied
 * ledger sequence number up to the current chain tip.
 *
 * Security
 * ────────
 * • Requires a valid admin JWT (`role: "admin"`) in the Authorization header.
 * • Rate-limited to `rateLimitPerMinute` (default 60) requests per minute,
 *   keyed on the raw Authorization header so each distinct admin token gets
 *   its own bucket. Unauthenticated callers fall back to IP-based throttling.
 *
 * Audit
 * ─────
 * • A structured row is written to `auditLogs` (action: "admin.reindex") on
 *   every successful invocation for compliance and forensic traceability.
 *
 * Observability
 * ─────────────
 * • Increments the `admin_reindex_total` Prometheus counter on success.
 * • Emits a structured pino log at INFO level with the caller address and
 *   the resolved ledger range so operators can grep for reindex activity.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { logger } from "../../config/logger";
import { requireAdmin } from "../../middleware/requireAdmin";
import { CORRELATION_ID_HEADER } from "../../lib/http";
import { getCorrelationId } from "../../middleware/correlation";
import { indexerService } from "../../services/indexerService";
import { adminReindexTotal } from "../../metrics/registry";
import { createAuditLog } from "../../services/auditService";

// ── Validation schema ────────────────────────────────────────────────────────

/** Body accepted by POST /api/admin/reindex */
const bodySchema = z.object({
  /** Ledger sequence number to start reindexing from. Must be a positive integer. */
  ledger: z.number().int().positive(),
});

// ── Router options ───────────────────────────────────────────────────────────

export interface AdminReindexRouterOptions {
  /**
   * Maximum number of requests per minute per admin token.
   * Defaults to 60 (matching all other admin routers).
   */
  rateLimitPerMinute?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolves the correlation ID from AsyncLocalStorage context, then req.id fallback. */
function resolveRequestId(req: { id?: unknown }): string {
  return (
    getCorrelationId() ??
    (typeof req.id === "string" ? req.id : "") ??
    ""
  );
}

/** Extracts the client IP from forwarded headers or the socket, matching other admin routes. */
function extractClientIp(req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0] ?? "unknown";
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createAdminReindexRouter(
  opts: AdminReindexRouterOptions = {},
): Router {
  const router = Router();
  const rpmLimit = opts.rateLimitPerMinute ?? 60;

  // ── Rate limiter ───────────────────────────────────────────────────────────
  // Key on the raw Authorization header so each admin token has its own
  // bucket. Falls back to IP for unauthenticated callers so they are still
  // throttled before they reach requireAdmin.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: rpmLimit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ??
        req.ip ??
        "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ────────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── POST / ────────────────────────────────────────────────────────────────
  /**
   * Validates the request body, resolves the current chain tip, enqueues
   * a backfill from `ledger` → `chainTip`, then returns the resolved range
   * so the caller can track progress via the indexer health probe.
   */
  router.post("", async (req, res, next) => {
    try {
      const correlationId = resolveRequestId(req);

      // ── Input validation ─────────────────────────────────────────────────
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.setHeader(CORRELATION_ID_HEADER, correlationId);
        res.status(400).json({
          error: {
            code: "validation_error",
            details: parsed.error.issues,
            correlationId,
          },
        });
        return;
      }

      const { ledger: from } = parsed.data;

      // ── Before-state snapshot ─────────────────────────────────────────────
      // Capture cursor position prior to the backfill so the audit row shows
      // the full before→after transition.
      const previousCursor = await indexerService.getCursor();

      // ── Backfill ─────────────────────────────────────────────────────────
      // getChainTip() goes to Soroban RPC; backfillRange() is chunked and
      // writes to indexer_events with ON CONFLICT DO NOTHING (idempotent).
      const to = await indexerService.getChainTip();
      await indexerService.backfillRange(from, to);

      // ── Audit log ─────────────────────────────────────────────────────────
      // Written after the backfill so a failed backfill produces no audit row.
      // beforeState / afterState capture the cursor transition for forensic
      // traceability.
      const ip = extractClientIp(req as Parameters<typeof extractClientIp>[0]);
      await createAuditLog({
        action: "admin.reindex",
        walletAddress: req.adminAddress ?? undefined,
        ip,
        correlationId,
        beforeState: { cursor: previousCursor, from },
        afterState: { cursor: to, from, to },
      });

      // ── Metrics & structured log ──────────────────────────────────────────
      adminReindexTotal.inc();
      logger.info(
        {
          correlationId,
          adminAddress: req.adminAddress,
          from,
          to,
        },
        "admin reindex triggered",
      );

      // ── Response ──────────────────────────────────────────────────────────
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      res.status(200).json({
        data: { from, to },
        correlationId,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/** Default singleton wired into src/index.ts. */
export const adminReindexRouter = createAdminReindexRouter();
