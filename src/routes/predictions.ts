/**
 * /api/predictions — prediction claim flow.
 *
 * All routes require authentication via the `requireAuth` middleware.
 * Idempotency-Key header is supported for the POST /claim mutation via the
 * global idempotency middleware applied in `src/index.ts`.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { claimWinnings, ClaimError } from "../services/claimService";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { createPerUserRateLimiter } from "../middleware/rateLimit";
import { getPredictionExplanation } from "../services/predictionExplainService";
import cancelRouter from "./predictions/cancel";
import { createShareRouter } from "./predictions/share";
import { predictionsHealthRouter } from "./predictions/health";
import { listPredictions } from "../repositories/predictionRepo";
import { clampLimit } from "../utils/cursor";
import {
  predictionsListTotal,
  predictionExplainTotal,
  predictionsRequestDuration,
} from "../metrics/registry";
import type { AuthenticatedRequest } from "../middleware/auth";
import { listPredictionsQuerySchema } from "../validators/predictions";
import { requestTimeout } from "../middleware/timeout";
import { conditionalGet } from "../middleware/etag";

export const predictionsRouter = Router();

// ── Per-request timeout middleware ────────────────────────────────────────
predictionsRouter.use(requestTimeout(15000));

// ── Public sub-routers (no auth required) ────────────────────────────────
// Must be registered before the requireAuth guard so bots / crawlers can
// fetch social-preview metadata without credentials.

/**
 * GET /api/predictions/:id/share
 * Returns OG + Twitter card metadata for a prediction.
 * Public — no authentication required.
 */
predictionsRouter.use("/", createShareRouter());
predictionsRouter.use("/", cancelRouter);
predictionsRouter.use("/", predictionsHealthRouter);

// ── Authenticated routes ──────────────────────────────────────────────────
predictionsRouter.use(requireAuth);
predictionsRouter.use(
  createPerUserRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    keyGenerator: (req) => {
      const userId = (req as AuthenticatedRequest).user?.id;
      if (typeof userId === "string" && userId.trim().length > 0) {
        return `predictions:${userId}`;
      }

      return `predictions:unknown`;
    },
  }),
);

// ---------------------------------------------------------------------------
// POST /api/predictions/claim
// ---------------------------------------------------------------------------

const claimBodySchema = z
  .object({
    marketId: z.string().min(1, "marketId is required"),
  })
  .strict();

/**
 * POST /api/predictions/claim
 *
 * Claims winnings for a winning prediction after the parent market has been
 * resolved.  Builds and submits a Soroban claim transaction, then persists
 * the on-chain tx hash on the prediction row.
 *
 * Request body:
 * ```json
 * { "marketId": "uuid-or-text-id" }
 * ```
 *
 * Idempotent via:
 *   - Internal guard: if claimTxHash is already set, returns existing data.
 *   - HTTP layer: the global idempotency middleware (Idempotency-Key header).
 *
 * Responses:
 *   200 — Claim successful (or previously claimed — idempotent replay).
 *   400 — Market not resolved, prediction not a winner, or validation error.
 *   401 — Missing or invalid Bearer token.
 *   404 — Market or prediction not found.
 *   500 — Soroban transaction submission failed.
 */
predictionsRouter.post("/claim", async (req, res, next) => {
  try {
    const parsed = claimBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          details: parsed.error.flatten().fieldErrors,
        },
      });
      return;
    }

    const { marketId } = parsed.data;
    const claimUser = (req as unknown as { user: { id: string; stellarAddress: string } }).user;
    const requestId = getRequestId();

    logger.info(
      { reqId: requestId, marketId, userId: claimUser.id },
      "claim: processing claim request",
    );

    const result = await claimWinnings({
      marketId,
      userId: claimUser.id,
      stellarAddress: claimUser.stellarAddress,
    });

    logger.info(
      { reqId: requestId, marketId, userId: claimUser.id, claimTxHash: result.claimTxHash },
      "claim: completed successfully",
    );

    res.status(200).json({ data: result });
  } catch (e) {
    if (e instanceof ClaimError) {
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
      return;
    }
    next(e);
  }
});

/**
 * GET /api/predictions
 *
 * Returns a cursor-paginated list of predictions belonging to the authenticated
 * user.
 *
 * Query parameters:
 *   - marketId (optional) — filter to a single market
 *   - status   (optional) — one of: pending, confirmed, won, lost, claimed
 *   - outcome  (optional) — e.g. "yes" / "no"
 *   - cursor   (optional) — opaque token from the previous page's `next_cursor`
 *   - limit    (optional, default 20, max 100) — page size
 *
 * Response:
 *   200 { items: PredictionRow[], next_cursor: string | null, total?: number }
 *
 * Pagination:
 *   `next_cursor` is null on the last page. Pass it verbatim as `?cursor=` to
 *   fetch the next page. Cursors are versioned; a stale or tampered cursor
 *   safely restarts from page 1 rather than returning a wrong offset.
 *
 * Errors:
 *   400 validation_error — query params fail the zod schema
 *   401 unauthorized     — missing or invalid JWT (enforced by requireAuth)
 */
predictionsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const reqId = getRequestId();
    const startMs = Date.now();

    try {
      // ── Input validation ─────────────────────────────────────────────────
      const queryParse = listPredictionsQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        predictionsListTotal.inc({ outcome: "error" });
        predictionsRequestDuration.observe(
          { handler: "list", outcome: "error" },
          (Date.now() - startMs) / 1000,
        );
        logger.warn(
          { reqId, issues: queryParse.error.issues },
          "predictions_list_invalid_query",
        );
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              queryParse.error.issues[0]?.message ?? "invalid query parameters",
            requestId: reqId,
          },
        });
        return;
      }

      const { marketId, status, outcome, cursor, limit: rawLimit } =
        queryParse.data;

      // clampLimit is a belt-and-suspenders guard; zod already enforces 1–100.
      const limit = clampLimit(rawLimit);

      const userId = (req as AuthenticatedRequest).user!.id;

      logger.debug(
        { reqId, userId, marketId, status, outcome, limit, hasCursor: !!cursor },
        "predictions_list_request",
      );

      // ── Data access ──────────────────────────────────────────────────────
      const page = await listPredictions(userId, {
        marketId,
        status,
        outcome,
        limit,
        cursor,
      });

      const payload = { items: page.data, next_cursor: page.nextCursor };
      if (conditionalGet(payload, req, res)) return;

      logger.info(
        {
          reqId,
          userId,
          count: page.data.length,
          hasNext: !!page.nextCursor,
        },
        "predictions_list_served",
      );

      predictionsListTotal.inc({ outcome: "success" });
      predictionsRequestDuration.observe(
        { handler: "list", outcome: "success" },
        (Date.now() - startMs) / 1000,
      );

      res.json({ items: page.data, next_cursor: page.nextCursor });
    } catch (err) {
      predictionsListTotal.inc({ outcome: "error" });
      predictionsRequestDuration.observe(
        { handler: "list", outcome: "error" },
        (Date.now() - startMs) / 1000,
      );
      next(err);
    }
  },
);

/**
 * GET /api/predictions/:id/explain
 * Returns the resolution computation trail for a prediction (educational endpoint).
 * Shows oracle inputs, market resolution, and payout calculation.
 */
predictionsRouter.get("/:id/explain", async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { id } = req.params;
    const explanation = await getPredictionExplanation(id);
    predictionExplainTotal.inc({ outcome: "success" });
    predictionsRequestDuration.observe(
      { handler: "explain", outcome: "success" },
      (Date.now() - startMs) / 1000,
    );
    res.json(explanation);
  } catch (error) {
    predictionExplainTotal.inc({ outcome: "error" });
    predictionsRequestDuration.observe(
      { handler: "explain", outcome: "error" },
      (Date.now() - startMs) / 1000,
    );
    next(error);
  }
});
