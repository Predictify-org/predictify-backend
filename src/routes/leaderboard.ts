import { Router } from "express";
import {
  getLeaderboard,
  getLeaderboardWithRefresh,
  getLeaderboardPage,
  getLeaderboardPageWithRefresh,
  getUserLeaderboardEntry,
  LeaderboardEntry,
} from "../services/leaderboardService";
import { rateLimitAnon } from "../middleware/rateLimitAnon";
import { conditionalGet } from "../middleware/etag";
import { RouteErrorFactory } from "../errors";
import { abortableRace, requestTimeout, RequestAbortedError } from "../middleware/timeout";
import { logger } from "../config/logger";
import { leaderboardMetricsMiddleware } from "../metrics/leaderboardMetrics";
import {
  leaderboardQuerySchema,
  leaderboardUserParamsSchema,
  leaderboardUserQuerySchema,
} from "../validators/leaderboard";

export const leaderboardRouter = Router();

/**
 * Leaderboard reads hit a materialized view (and optionally trigger a
 * synchronous REFRESH via `?refresh=true`), so a slow/locked view can hang
 * the request far longer than a normal read. Bound it and fail with a 504
 * rather than tying up the connection indefinitely.
 */
const LEADERBOARD_TIMEOUT_MS = 5000;

// Registered ahead of rate limiting / the timeout guard so that latency for
// rejected requests (429s, 504s) is captured too, not just successful 200s.
leaderboardRouter.use(leaderboardMetricsMiddleware);
leaderboardRouter.use(rateLimitAnon);
leaderboardRouter.use(
  requestTimeout(LEADERBOARD_TIMEOUT_MS, {
    statusCode: 504,
    code: "gateway_timeout",
    message: "Leaderboard request timed out",
  }),
);

leaderboardRouter.get("/", async (req, res, next) => {
  const signal = res.locals.abortSignal as AbortSignal | undefined;
  const correlationId = String((req as { id?: unknown }).id ?? "unknown");

  // ── 1. Validate query parameters at the route boundary ──────────────────
  const queryParse = leaderboardQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    logger.warn(
      { correlationId, issues: queryParse.error.issues },
      "leaderboard_invalid_query",
    );
    res.status(400).json({
      error: {
        code: "validation_error",
        message: queryParse.error.issues[0]?.message ?? "invalid query parameters",
        details: queryParse.error.issues,
        requestId: correlationId,
      },
    });
    return;
  }

  const { limit, offset, refresh, period, cursor } = queryParse.data;

  try {
    let entries: LeaderboardEntry[];
    let nextCursor: string | null = null;

    // Cursor-based pagination is used when:
    // 1. An explicit cursor is provided (continuation page), or
    // 2. No offset was specified (first page — gives clients a nextCursor
    //    for subsequent requests, which is stable under concurrent writes).
    // Explicit offset > 0 falls back to the legacy OFFSET path so existing
    // callers continue to work unchanged.
    const useCursor = cursor !== undefined || offset === 0;

    if (useCursor) {
      const fetch = refresh
        ? getLeaderboardPageWithRefresh(limit, period, cursor)
        : getLeaderboardPage(limit, period, cursor);
      ({ entries, nextCursor } = await abortableRace(fetch, signal));
    } else {
      const data = refresh
        ? await abortableRace(getLeaderboardWithRefresh(limit, offset, period), signal)
        : await abortableRace(getLeaderboard(limit, offset, period), signal);
      entries = data;
    }

    const payload: Record<string, unknown> = {
      data: entries,
      meta: {
        limit,
        offset,
        count: entries.length,
        refresh,
        period,
      },
    };

    if (nextCursor) {
      payload.nextCursor = nextCursor;
    }

    // Strong ETag on the leaderboard payload; 304 if client already has it.
    if (conditionalGet(payload, req, res)) return;
    res.json(payload);
  } catch (e) {
    if (e instanceof RequestAbortedError) {
      // The timeout middleware already sent (or the client already dropped)
      // the response; just stop working and log for observability.
      logger.warn(
        { correlationId, path: req.path },
        "Abandoned /api/leaderboard request after timeout",
      );
      return;
    }
    next(e);
  }
});

leaderboardRouter.get("/user/:stellarAddress", async (req, res, next) => {
  const signal = res.locals.abortSignal as AbortSignal | undefined;
  const correlationId = String((req as { id?: unknown }).id ?? "unknown");

  // ── 1. Validate route parameters at the route boundary ──────────────────
  const paramsParse = leaderboardUserParamsSchema.safeParse(req.params);
  if (!paramsParse.success) {
    logger.warn(
      { correlationId, stellarAddress: req.params.stellarAddress, issues: paramsParse.error.issues },
      "leaderboard_user_invalid_params",
    );
    res.status(400).json({
      error: {
        code: "validation_error",
        message: paramsParse.error.issues[0]?.message ?? "invalid route parameters",
        details: paramsParse.error.issues,
        requestId: correlationId,
      },
    });
    return;
  }

  // ── 2. Validate query parameters ────────────────────────────────────────
  const queryParse = leaderboardUserQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    logger.warn(
      { correlationId, stellarAddress: req.params.stellarAddress, issues: queryParse.error.issues },
      "leaderboard_user_invalid_query",
    );
    res.status(400).json({
      error: {
        code: "validation_error",
        message: queryParse.error.issues[0]?.message ?? "invalid query parameters",
        details: queryParse.error.issues,
        requestId: correlationId,
      },
    });
    return;
  }

  const { stellarAddress } = paramsParse.data;
  const { period } = queryParse.data;

  try {
    const entry = await abortableRace(getUserLeaderboardEntry(stellarAddress, period), signal);
    if (!entry) {
      throw RouteErrorFactory.notFound("Leaderboard entry not found");
    }

    // Strong ETag on the entry payload; 304 if client already has it.
    const payload = { data: entry };
    if (conditionalGet(payload, req, res)) return;
    res.json(payload);
  } catch (e) {
    if (e instanceof RequestAbortedError) {
      logger.warn(
        { correlationId, path: req.path },
        "Abandoned /api/leaderboard/user request after timeout",
      );
      return;
    }
    next(e);
  }
});
