/**
 * /api/predictions — prediction claim flow, cursor-paginated listing,
 * and resolution explanation.
 *
 * Cursor pagination over (created_at DESC, id DESC) keeps the result set
 * stable under concurrent writes.  The cursor encodes the last row's
 * (createdAt, id) pair as a versioned, base64url-encoded token.
 * See `src/utils/cursor.ts` for wire format details.
 *
 * Design
 * ------
 * - All routes require authentication via `requireAuth`.
 * - GET / (list) uses keyset pagination; `nextCursor` is null on the last page.
 * - POST /claim/prepare + POST /claim form the user-signed claim flow; the
 *   server never signs. Submit is idempotent on its own and via the global
 *   Idempotency-Key middleware.
 * - GET /:id/explain is a read-only educational endpoint.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { prepareClaim, submitClaim, ClaimError } from "../services/claimService";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { createPerUserRateLimiter } from "../middleware/rateLimit";
import { getPredictionExplanation } from "../services/predictionExplainService";
import cancelRouter from "./predictions/cancel";
import { createShareRouter } from "./predictions/share";
import { predictionsHealthRouter } from "./predictions/health";
import { listPredictions } from "../repositories/predictionRepo";
import { conditionalGet } from "../middleware/etag";
import { clampLimit } from "../utils/cursor";
import {
  predictionsListTotal,
  predictionExplainTotal,
  predictionsRequestDuration,
} from "../metrics/registry";
import type { AuthenticatedRequest } from "../middleware/auth";
import { listPredictionsQuerySchema, predictionIdParamSchema } from "../validators/predictions";
import { requestTimeout } from "../middleware/timeout";

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

/**
 * GET /api/predictions/:id/explain
 * Returns the resolution computation trail for a prediction (educational endpoint).
 * Shows oracle inputs, market resolution, and payout calculation.
 * Public — no authentication required.
 */
predictionsRouter.get("/:id/explain", async (req, res, next) => {
  const startMs = Date.now();
  try {
    const paramsResult = predictionIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      predictionExplainTotal.inc({ outcome: "error" });
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: paramsResult.error.issues[0]?.message ?? "Invalid prediction ID",
          requestId: getRequestId(),
        },
      });
    }
    const { id } = paramsResult.data;
    const explanation = await getPredictionExplanation(id);
    predictionExplainTotal.inc({ outcome: "success" });
    predictionsRequestDuration.observe(
      { handler: "explain", outcome: "success" },
      (Date.now() - startMs) / 1000,
    );
    if (conditionalGet(explanation, req, res)) return;
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
// POST /api/predictions/claim/prepare  and  POST /api/predictions/claim
// ---------------------------------------------------------------------------

/** Soroban `Symbol`: at most 32 characters of `[A-Za-z0-9_]`. */
const sorobanSymbolSchema = z
  .string()
  .min(1, "marketId is required")
  .max(32, "marketId must be at most 32 characters")
  .regex(/^[A-Za-z0-9_]+$/, "marketId must be a valid Soroban Symbol ([A-Za-z0-9_])");

const claimPrepareBodySchema = z
  .object({
    marketId: sorobanSymbolSchema,
  })
  .strict();

/** Signed transaction envelope: base64, at most 16 KB. */
const MAX_SIGNED_XDR_LENGTH = 16 * 1024;

const claimSubmitBodySchema = z
  .object({
    claimId: z.string().uuid("claimId must be a UUID"),
    signedXdr: z
      .string()
      .min(1, "signedXdr is required")
      .max(MAX_SIGNED_XDR_LENGTH, "signedXdr exceeds the 16 KB limit")
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "signedXdr must be base64"),
  })
  .strict();

type ClaimUser = { id: string; stellarAddress: string };

function sendClaimValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: {
      code: "validation_error",
      details: error.flatten().fieldErrors,
    },
  });
}

function sendClaimError(res: Response, e: ClaimError): void {
  res.status(e.status).json({
    error: { code: e.code, message: e.message, requestId: getRequestId() },
  });
}

/**
 * POST /api/predictions/claim/prepare
 *
 * Builds and simulates an unsigned `claim_winnings(user, market_id,
 * claim_nonce)` transaction with the caller as source. The wallet signs it
 * and the result is sent to `POST /api/predictions/claim`. The server never
 * signs. A second prepare while a claim is outstanding returns that claim.
 *
 * Request body: `{ "marketId": "<Soroban Symbol>" }`
 *
 * Responses:
 *   200 — `{ data: { xdr, networkPassphrase, expiresAt, claimId } }`
 *   400 — Validation error, market not resolved, or prediction not winning.
 *   401 — Missing or invalid Bearer token.
 *   404 — Market or prediction not found.
 *   409 — Already claimed, claim in progress, or claim_nonce_unavailable.
 *   422 — claim_simulation_failed.
 */
predictionsRouter.post("/claim/prepare", async (req, res, next) => {
  try {
    const parsed = claimPrepareBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendClaimValidationError(res, parsed.error);
      return;
    }

    const { marketId } = parsed.data;
    const claimUser = (req as unknown as { user: ClaimUser }).user;
    logger.info(
      { reqId: getRequestId(), marketId, userId: claimUser.id },
      "claim: processing prepare request",
    );

    const data = await prepareClaim({
      marketId,
      userId: claimUser.id,
      stellarAddress: claimUser.stellarAddress,
    });
    res.status(200).json({ data });
  } catch (e) {
    if (e instanceof ClaimError) {
      sendClaimError(res, e);
      return;
    }
    next(e);
  }
});

/**
 * POST /api/predictions/claim
 *
 * Accepts the wallet-signed XDR for a prepared claim, checks that it is
 * exactly the prepared transaction, submits it, and records the result for
 * the settle-confirmer.
 *
 * Request body: `{ "claimId": "<uuid>", "signedXdr": "<base64, <= 16 KB>" }`
 *
 * Idempotent: replaying a submit for a `paid` claim returns the stored result
 * with 200; a `failed` or `expired` claim returns 409. This holds
 * independently of the global Idempotency-Key middleware.
 *
 * Responses:
 *   200 — Submitted (or previously submitted).
 *   400 — Validation error or claim_xdr_mismatch.
 *   401 — Missing or invalid Bearer token.
 *   404 — Claim not found.
 *   409 — claim_expired, claim_in_progress, or a previously failed claim.
 *   422 — claim_rejected.
 *   503 — claim_rpc_unavailable (safe to retry).
 */
predictionsRouter.post("/claim", async (req, res, next) => {
  try {
    const parsed = claimSubmitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendClaimValidationError(res, parsed.error);
      return;
    }

    const { claimId, signedXdr } = parsed.data;
    const claimUser = (req as unknown as { user: ClaimUser }).user;
    logger.info(
      { reqId: getRequestId(), claimId, userId: claimUser.id },
      "claim: processing submit request",
    );

    const data = await submitClaim({
      claimId,
      signedXdr,
      userId: claimUser.id,
      stellarAddress: claimUser.stellarAddress,
    });
    res.status(200).json({ data });
  } catch (e) {
    if (e instanceof ClaimError) {
      sendClaimError(res, e);
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

      const payload = { data: page.data, nextCursor: page.nextCursor };
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

      res.json(payload);
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

