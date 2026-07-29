/**
 * GET /api/leaderboard/global
 * GET /api/leaderboard/global/user/:stellarAddress
 *
 * Global leaderboard aggregated across ALL markets and ALL time.
 * Unlike the market-scoped /api/leaderboard endpoint, this view does not
 * filter by resolution period; it reflects a user's complete prediction
 * history across the entire platform.
 *
 * Rate limiting: reuses the existing anonymous rate-limiter so unauthenticated
 * callers share the bucket.  Authenticated callers bypass the limiter.
 */
import { Router } from "express";
import { z } from "zod";
import { rateLimitAnon } from "../../middleware/rateLimitAnon";
import { logger } from "../../config/logger";
import {
  getGlobalLeaderboard,
  getGlobalLeaderboardEntry,
  getGlobalLeaderboardWithRefresh,
} from "../../services/globalLeaderboardService";

export const globalLeaderboardRouter = Router();

// Apply anonymous rate limiting; authenticated Bearer callers bypass it.
globalLeaderboardRouter.use(rateLimitAnon);

// ── Validation schemas ─────────────────────────────────────────────────────

/**
 * Query-parameter schema for the paginated list endpoint.
 *
 * All fields are optional; Zod coerces and defaults them so callers can
 * omit any subset.
 *
 * - limit:   1–100 (guards against accidental large fetches)
 * - offset:  ≥ 0
 * - refresh: when true the underlying materialized view is refreshed before
 *            the query runs; expensive – intended for admin/debug usage.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  refresh: z.coerce.boolean().default(false),
});

export type GlobalLeaderboardListQuery = z.infer<typeof listQuerySchema>;

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/leaderboard/global
 *
 * Returns a paginated global leaderboard sorted by rank ascending.
 * Rank is computed from accuracy_percentage DESC then total_predictions DESC.
 *
 * @query limit   {number}  default 50, max 100
 * @query offset  {number}  default 0
 * @query refresh {boolean} default false – force materialized view refresh
 *
 * @returns 200 { data: GlobalLeaderboardEntry[], meta: { limit, offset, count, refresh } }
 * @returns 400 on invalid query parameters
 * @returns 500 on unexpected server errors
 */
globalLeaderboardRouter.get("/", async (req, res, next) => {
  // Correlation ID comes from the request context set up in index.ts
  const correlationId = String((req as { id?: unknown }).id ?? "unknown");

  const parseResult = listQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    logger.warn(
      { correlationId, issues: parseResult.error.issues },
      "global_leaderboard_invalid_query",
    );
    res.status(400).json({
      error: {
        code: "validation_error",
        details: parseResult.error.issues,
        requestId: correlationId,
      },
    });
    return;
  }

  const { limit, offset, refresh } = parseResult.data;

  try {
    logger.info(
      { correlationId, limit, offset, refresh },
      "global_leaderboard_requested",
    );

    const data = refresh
      ? await getGlobalLeaderboardWithRefresh(limit, offset)
      : await getGlobalLeaderboard(limit, offset);

    logger.info(
      { correlationId, count: data.length, refresh },
      "global_leaderboard_served",
    );

    res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        refresh,
      },
    });
  } catch (e) {
    logger.error({ correlationId, err: e }, "global_leaderboard_error");
    next(e);
  }
});

/**
 * GET /api/leaderboard/global/user/:stellarAddress
 *
 * Returns a single user's global leaderboard entry.
 *
 * @param stellarAddress - The user's Stellar public key (G…)
 *
 * @returns 200 { data: GlobalLeaderboardEntry }
 * @returns 404 { error: { code: "not_found" } } when the address is unknown
 * @returns 500 on unexpected server errors
 */
globalLeaderboardRouter.get("/user/:stellarAddress", async (req, res, next) => {
  const correlationId = String((req as { id?: unknown }).id ?? "unknown");
  const { stellarAddress } = req.params;

  try {
    logger.info(
      { correlationId, stellarAddress },
      "global_leaderboard_user_requested",
    );

    const entry = await getGlobalLeaderboardEntry(stellarAddress);

    if (!entry) {
      logger.info(
        { correlationId, stellarAddress },
        "global_leaderboard_user_not_found",
      );
      res.status(404).json({
        error: { code: "not_found", requestId: correlationId },
      });
      return;
    }

    logger.info(
      { correlationId, stellarAddress, rank: entry.rank },
      "global_leaderboard_user_served",
    );

    res.json({ data: entry });
  } catch (e) {
    logger.error(
      { correlationId, stellarAddress, err: e },
      "global_leaderboard_user_error",
    );
    next(e);
  }
});
