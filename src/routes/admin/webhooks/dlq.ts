/**
 * Admin DLQ list endpoint.
 *
 *   GET /api/admin/webhooks/dlq
 *
 * Returns a paginated, newest-first list of dead-lettered webhook deliveries
 * for operator review.  Pagination is keyset-based so listings stay stable
 * while the DLQ is being actively written to or replayed.
 *
 * Auth:   Bearer JWT with { role: "admin" }  →  401/403 if missing or wrong role
 * Rate:   60 req/min per admin token (falls back to IP for unauthenticated calls)
 *
 * Query params:
 *   cursor  – opaque value returned by a previous page (omit for the first page)
 *   limit   – items per page, 1–100 (default 20; values outside range are clamped)
 *
 * Response  200:
 *   { data: DlqItem[], nextCursor: string | null }
 *
 * Error envelope (all errors):
 *   { error: { code: string, message?: string, requestId?: string } }
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import type { WebhookStore, DlqRow } from "../../../services/webhookStore";

// ── Deps injection contract ──────────────────────────────────────────────────

/**
 * Dependencies required by this router.
 *
 * Injected via the factory so tests can supply a fast in-memory store without
 * touching Postgres, while production wires in `DrizzleWebhookStore` from
 * `src/index.ts`.
 */
export interface AdminDlqRouterDeps {
  store: WebhookStore;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface AdminDlqRouterOptions {
  /** Maximum requests per minute per admin token.  Default: 60 */
  rateLimitPerMinute?: number;
}

// ── Input validation ─────────────────────────────────────────────────────────

/**
 * Validates the raw query string.
 *
 * `cursor`  – non-empty opaque page token (omit → start from first page).
 * `limit`   – digit-only string parsed later; clamping to [1, 100] is done by
 *             `WebhookStore.listDlq` (via the shared `clampLimit` helper) so a
 *             value such as "0" or "999" is silently corrected rather than
 *             returning a 400.
 */
const dlqQuerySchema = z.object({
  cursor: z
    .string()
    .min(1, { message: "cursor must not be empty when provided" })
    .optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { message: "limit must be a positive integer" })
    .optional(),
});

// ── Serialiser ───────────────────────────────────────────────────────────────

/**
 * Converts a raw `DlqRow` into the public API shape.
 *
 * `payload` is a Buffer of the original signed request body bytes.  It is
 * exposed as base64 so it is safe to embed in JSON and can be decoded by the
 * caller for inspection or re-signing.  Raw bytes are never returned.
 */
function serializeDlqRow(row: DlqRow) {
  return {
    id: row.id,
    originalId: row.originalId,
    eventId: row.eventId,
    eventType: row.eventType,
    targetUrl: row.targetUrl,
    /** Original signed body, base64-encoded.  Never the raw Buffer. */
    payloadBase64: row.payload.toString("base64"),
    signature: row.signature,
    headers: row.headers,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    failedAt: row.failedAt.toISOString(),
    replayedAt: row.replayedAt ? row.replayedAt.toISOString() : null,
    replayDeliveryId: row.replayDeliveryId,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates an Express Router that exposes `GET /` relative to its mount path.
 *
 * Mount at `/api/admin/webhooks/dlq` in `src/index.ts` to get the full URL.
 *
 * Design notes:
 * - Rate limiter runs **before** `requireAdmin` so unauthenticated callers are
 *   throttled before any auth logic executes.
 * - `requireAdmin` enforces the `{ role: "admin" }` JWT claim and attaches
 *   `req.adminAddress` for audit/log enrichment downstream.
 * - Zod validates query params at the boundary; malformed input returns 400 with
 *   a standardised error envelope before any store call is attempted.
 * - Every code path emits a structured pino log entry tagged with `requestId`,
 *   `adminAddress`, and pagination context so operators can correlate log lines
 *   with individual requests in production.
 */
export function createAdminDlqRouter(
  deps: AdminDlqRouterDeps,
  opts: AdminDlqRouterOptions = {},
): Router {
  const router = Router();
  const maxPerMinute = opts.rateLimitPerMinute ?? 60;

  // ── Rate limiter ───────────────────────────────────────────────────────────
  // Each admin token gets its own bucket.  Unauthenticated callers fall back to
  // IP-based keying so they are still throttled before reaching requireAdmin.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: maxPerMinute,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ────────────────────────────────────────────────────────────
  // Validates the Bearer JWT and sets req.adminAddress.
  router.use(requireAdmin);

  // ── GET / — paginated DLQ listing ─────────────────────────────────────────
  /**
   * Lists dead-lettered deliveries, newest first (ORDER BY failed_at DESC, id DESC).
   *
   * Keyset pagination keeps the listing correct and fast even when rows are
   * inserted (new failures) or removed (replayed/cleaned) between page fetches.
   */
  router.get("/", async (req, res, next) => {
    const requestId = getRequestId();

    try {
      // Step 1 – Validate query params at the boundary.
      const parseResult = dlqQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        const issue = parseResult.error.issues[0];
        logger.warn(
          {
            event: "dlq_list_validation_failed",
            requestId,
            adminAddress: req.adminAddress,
            issues: parseResult.error.issues,
          },
          "DLQ list: invalid query parameters",
        );
        res.status(400).json({
          error: {
            code: "validation_error",
            message: issue?.message ?? "invalid query parameters",
            requestId,
          },
        });
        return;
      }

      const { cursor, limit } = parseResult.data;

      // Step 2 – Structured log: request received.
      logger.info(
        {
          event: "dlq_list_requested",
          requestId,
          adminAddress: req.adminAddress,
          cursor: cursor ?? null,
          limit: limit ?? null,
        },
        "Admin DLQ list requested",
      );

      // Step 3 – Fetch one page from the store.
      //          listDlq handles cursor decoding and limit clamping internally
      //          via the shared `paginate` helper in src/utils/cursor.ts.
      const page = await deps.store.listDlq(cursor, limit);

      // Step 4 – Structured log: response ready.
      logger.info(
        {
          event: "dlq_list_returned",
          requestId,
          adminAddress: req.adminAddress,
          count: page.data.length,
          hasNextPage: page.nextCursor !== null,
        },
        "Admin DLQ list returned",
      );

      // Step 5 – Serialise (payload → base64) and respond.
      res.json({
        data: page.data.map(serializeDlqRow),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      // Structured error log before delegating to the global error handler.
      logger.error(
        {
          event: "dlq_list_error",
          requestId,
          adminAddress: req.adminAddress,
          error: err instanceof Error ? err.message : String(err),
        },
        "Admin DLQ list encountered an unexpected error",
      );
      next(err);
    }
  });

  return router;
}
