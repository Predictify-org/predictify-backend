/**
 * @module routes/indexer/cursor
 *
 * State-changing endpoints for the indexer cursor.
 *
 *   POST   /api/indexer/cursor   — advance the cursor to a specific ledger
 *   DELETE /api/indexer/cursor   — reset the cursor back to the configured
 *                                  INDEXER_START_LEDGER (effectively 0 for
 *                                  re-indexing from genesis)
 *
 * Security
 * ────────
 * Both endpoints require a valid admin JWT (`role: "admin"`) via the
 * `requireAdmin` middleware. Unauthenticated callers receive 403.
 * Rate-limited per admin token (default 60 req/min).
 *
 * Audit
 * ─────
 * Every successful mutation writes a structured row to `audit_logs` via
 * `createAuditLog`.  The row captures:
 *   • action        — "indexer.cursor.advance" | "indexer.cursor.reset"
 *   • walletAddress — the admin's Stellar address (actor)
 *   • ip            — resolved from x-forwarded-for or socket
 *   • correlationId — forwarded from AsyncLocalStorage / request id
 *   • beforeState   — { cursor: <previous ledger> }
 *   • afterState    — { cursor: <new ledger> }
 *
 * Observable side-effects
 * ───────────────────────
 * • Structured pino log at INFO level on success.
 * • Audit failure is non-fatal (caught and logged at WARN by auditService).
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in `IndexerCursorRouterDeps` so tests
 * can substitute fully-controlled stubs without network or DB access.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { logger } from "../../config/logger";
import { requireAdmin } from "../../middleware/requireAdmin";
import { CORRELATION_ID_HEADER } from "../../lib/http";
import { getCorrelationId } from "../../middleware/correlation";
import { createAuditLog } from "../../services/auditService";
import { indexerService } from "../../services/indexerService";
import { env } from "../../config/env";

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Body accepted by POST /api/indexer/cursor.
 * `ledger` must be a positive integer (ledger sequences start at 1).
 */
const advanceCursorBodySchema = z.object({
  ledger: z.number().int().positive(),
});

// ── Router options ────────────────────────────────────────────────────────────

export interface IndexerCursorRouterOptions {
  /**
   * Maximum requests per minute per admin token.
   * Defaults to 60 — matching all other admin-scoped routers.
   */
  rateLimitPerMinute?: number;
}

// ── Injectable dependency interface ──────────────────────────────────────────

export interface IndexerCursorRouterDeps {
  /** Read the current persisted cursor value (defaults to indexerService.getCursor). */
  getCursor?: () => Promise<number>;
  /** Advance the cursor to the given ledger (defaults to indexerService.advanceCursor). */
  advanceCursor?: (ledger: number) => Promise<void>;
  /** Persist an audit log entry (defaults to createAuditLog). */
  auditLogger?: typeof createAuditLog;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the correlation ID from AsyncLocalStorage, then fall back to req.id. */
function resolveCorrelationId(req: { id?: unknown }): string {
  return (
    getCorrelationId() ??
    (typeof req.id === "string" ? req.id : "") ??
    ""
  );
}

/** Extract the client IP from forwarded headers or the socket. */
function extractClientIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): string {
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

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the /api/indexer/cursor router with injected dependencies.
 *
 * @param opts.rateLimitPerMinute  - Requests per minute per admin token (default 60).
 * @param deps.getCursor           - Override cursor reader (tests only).
 * @param deps.advanceCursor       - Override cursor writer (tests only).
 * @param deps.auditLogger         - Override audit logger (tests only).
 */
export function createIndexerCursorRouter(
  opts: IndexerCursorRouterOptions = {},
  deps: IndexerCursorRouterDeps = {},
): Router {
  const rpmLimit = opts.rateLimitPerMinute ?? 60;
  const getCursorFn = deps.getCursor ?? (() => indexerService.getCursor());
  const advanceCursorFn = deps.advanceCursor ?? ((l) => indexerService.advanceCursor(l));
  const auditLoggerFn = deps.auditLogger ?? createAuditLog;

  const router = Router();

  // ── Rate limiter ─────────────────────────────────────────────────────────
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

  // ── Admin guard ──────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── POST /api/indexer/cursor ─────────────────────────────────────────────
  /**
   * Advance the cursor to a specific ledger.
   *
   * Request body: { "ledger": <positive integer> }
   *
   * Response 200: { "data": { "from": <prev>, "to": <new> }, "correlationId": "…" }
   */
  router.post("", async (req, res, next) => {
    try {
      const correlationId = resolveCorrelationId(req);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);

      const parsed = advanceCursorBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            details: parsed.error.issues,
            correlationId,
          },
        });
      }

      const { ledger } = parsed.data;

      // Capture before-state for the audit log
      const previousCursor = await getCursorFn();
      const beforeState = { cursor: previousCursor };

      // Persist the new cursor position
      await advanceCursorFn(ledger);

      const afterState = { cursor: ledger };

      // Audit log — fire-and-forget (errors are caught inside auditService)
      const ip = extractClientIp(req as Parameters<typeof extractClientIp>[0]);
      await auditLoggerFn({
        action: "indexer.cursor.advance",
        walletAddress: (req as { adminAddress?: string }).adminAddress ?? undefined,
        ip,
        correlationId,
        beforeState,
        afterState,
      });

      logger.info(
        {
          correlationId,
          adminAddress: (req as { adminAddress?: string }).adminAddress,
          from: previousCursor,
          to: ledger,
        },
        "indexer_cursor_advanced",
      );

      return res.status(200).json({
        data: { from: previousCursor, to: ledger },
        correlationId,
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── DELETE /api/indexer/cursor ───────────────────────────────────────────
  /**
   * Reset the cursor to INDEXER_START_LEDGER (re-index from the beginning).
   *
   * No request body required.
   *
   * Response 200: { "data": { "from": <prev>, "to": <start_ledger> }, "correlationId": "…" }
   */
  router.delete("", async (req, res, next) => {
    try {
      const correlationId = resolveCorrelationId(req);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);

      // Capture before-state
      const previousCursor = await getCursorFn();
      const resetTarget = env.INDEXER_START_LEDGER;
      const beforeState = { cursor: previousCursor };

      // Reset the cursor
      await advanceCursorFn(resetTarget);

      const afterState = { cursor: resetTarget };

      // Audit log — fire-and-forget
      const ip = extractClientIp(req as Parameters<typeof extractClientIp>[0]);
      await auditLoggerFn({
        action: "indexer.cursor.reset",
        walletAddress: (req as { adminAddress?: string }).adminAddress ?? undefined,
        ip,
        correlationId,
        beforeState,
        afterState,
      });

      logger.info(
        {
          correlationId,
          adminAddress: (req as { adminAddress?: string }).adminAddress,
          from: previousCursor,
          to: resetTarget,
        },
        "indexer_cursor_reset",
      );

      return res.status(200).json({
        data: { from: previousCursor, to: resetTarget },
        correlationId,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** Default singleton wired into src/index.ts. */
export const indexerCursorRouter = createIndexerCursorRouter();
