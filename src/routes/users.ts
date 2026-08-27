/**
 * @module routes/users
 *
 * Public user-facing routes:
 *
 *   GET /api/users
 *     Cursor-paginated list of registered users (DESC createdAt, DESC id).
 *     Query: cursor?, limit (default 20, max 100)
 *     Supports strong ETag / 304 conditional GET.
 *
 *   GET /api/users/me
 *     Returns the authenticated user's own profile.  Requires a valid JWT
 *     (responds 403 on missing/invalid token via `requireAuthForbidden`).
 *     Supports strong ETag / 304 conditional GET.
 *
 *   GET /api/users/:address/predictions
 *     Returns a cursor-paginated list of predictions for the given Stellar
 *     address.  The address must be a valid Stellar public key (G…).
 *     Query: status?, cursor?, limit (default 20, max 100)
 *     Supports strong ETag / 304 conditional GET.
 *
 *   GET /api/users/:stellarAddress/profile
 *     Returns the public profile for any Stellar address.
 *     404 when no matching user row exists.
 *     Supports strong ETag / 304 conditional GET.
 *
 * All routes are wrapped by `accessLog` which:
 *   - Resolves / generates a correlation ID (X-Correlation-Id → X-Request-Id
 *     → req.id → new UUID) and stamps it on `res.locals.correlationId`.
 *   - Echoes the correlation ID back via the X-Correlation-Id response header.
 *   - Emits a structured `users_access_log` entry on every response finish.
 *
 * Rate limiting (issue #411 / users-rl-v7):
 *   - `createPerUserRateLimiter` (60 req/min, IETF draft-7 headers) on each route.
 *   - `GET /me` authenticates first, then keys by `users:{user.id}`.
 *   - Public GETs fall back to `users:ip:{ip}` (no soft auth — preserves 403/401 contracts).
 *   - `/api/users/health` is mounted separately and is not throttled here.
 *
 * Performance (migration 0025_users_filter_idx):
 *   - GET /api/users benefits from the composite index `users_created_at_id_idx`
 *     on (created_at DESC, id DESC).  PostgreSQL performs an Index Scan Backward
 *     instead of a Seq Scan + quicksort, cutting I/O from O(n) to O(log n + limit).
 *   - GET /api/users/:address/predictions and GET /api/users/:stellarAddress/profile
 *     both look up by stellar_address, which is already covered by the UNIQUE
 *     constraint index — no additional index required.
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  getUserByAddress,
  getUserPredictions,
  getCurrentUserProfile,
  listUsers,
} from "../services/userService";
import { requireAuthForbidden } from "../middleware/requireAuth";
import { AuthenticatedRequest } from "../middleware/auth";
import { accessLog } from "../middleware/accessLog";
import { createPerUserRateLimiter } from "../middleware/rateLimit";
import { conditionalGet } from "../middleware/etag";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { clampLimit } from "../utils/cursor";
import { RouteErrorFactory } from "../errors";
import { requestTimeout } from "../middleware/timeout";
import { usersMetricsMiddleware } from "../metrics/usersMetrics";
import {
  userPredictionsParamsSchema,
  userPredictionsQuerySchema,
  userProfileParamsSchema,
} from "../validators/users";

export const usersRouter = Router();

/**
 * Shared /api/users limiter. Authenticated requests (req.user set) use
 * `users:{id}`; anonymous traffic uses `users:ip:{ip}`.
 */
const usersRateLimit = createPerUserRateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (typeof userId === "string" && userId.trim().length > 0) {
      return `users:${userId}`;
    }
    return `users:ip:${req.socket?.remoteAddress ?? "unknown"}`;
  },
});

// ---------------------------------------------------------------------------
// Access log — must be the first middleware so every handler inherits the
// correlation ID via res.locals.correlationId.
// ---------------------------------------------------------------------------
usersRouter.use(accessLog);

// ---------------------------------------------------------------------------
// Per-request timeout with graceful abort on /api/users
// ---------------------------------------------------------------------------
usersRouter.use(
  requestTimeout(15000, {
    statusCode: 504,
    code: "gateway_timeout",
    message: "Request timed out",
  }),
); // 15s timeout → 504 Gateway Timeout

// ---------------------------------------------------------------------------
// Per-endpoint Prometheus metrics for /api/users
// ---------------------------------------------------------------------------
usersRouter.use(usersMetricsMiddleware);

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

/**
 * Returns a cursor-paginated list of all registered users, sorted newest-first
 * (DESC createdAt, DESC id).  The composite sort key `(createdAt, id)` is
 * stable: even when two users are created in the same millisecond the UUID
 * tie-breaker is unique, so pages never overlap or skip rows.
 *
 * The query is served via the `users_created_at_id_idx` composite index
 * (migration 0025_users_filter_idx), which eliminates the sequential scan and
 * sort step that would otherwise be required for every page request.
 *
 * Query parameters:
 *   - cursor  (optional) — opaque base64url token from the previous page's `nextCursor`
 *   - limit   (optional, default 20, max 100) — page size
 *
 * Response:
 *   { data: UserListRow[], nextCursor: string | null }
 *
 * Pagination:
 *   `nextCursor` is null on the last page.  Pass it verbatim as `?cursor=` to
 *   fetch the next page.  A missing, tampered, or version-mismatched cursor is
 *   silently treated as absent (restart from page one) rather than 500-ing.
 *
 * Caching:
 *   Strong ETag on the page payload; clients may revalidate with If-None-Match
 *   and receive 304 Not Modified when the page is unchanged.
 *
 * Errors:
 *   400 validation_error — query params fail the zod schema
 */
usersRouter.get(
  "/",
  usersRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    // Prefer the access-log correlation ID; fall back to ALS for non-route callers.
    const correlationId =
      (res.locals.correlationId as string | undefined) ?? getRequestId();
    const reqId = correlationId;

    try {
      // Validate and coerce all query parameters at the route boundary using
      // the shared listUsersQuerySchema from src/validators/users.ts.
      // .strict() rejects any unknown keys so malformed input is never silently
      // ignored — a client sending ?foo=bar gets a 400, not a silent no-op.
      const queryParse = listUsersQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        logger.warn(
          {
            correlationId,
            reqId,
            issues: queryParse.error.issues,
          },
          "users_list_invalid_query",
        );
        return res.status(400).json({
          error: {
            code: "validation_error",
            message:
              queryParse.error.issues[0]?.message ?? "invalid query parameters",
            requestId: reqId,
          },
        });
      }

      const { cursor, limit: rawLimit } = queryParse.data;
      // clampLimit is a belt-and-suspenders guard; zod already enforces 1–100.
      const limit = clampLimit(rawLimit);

      logger.debug(
        { correlationId, reqId, limit, hasCursor: !!cursor },
        "users_list_request",
      );

      const page = await listUsers({ cursor, limit });

      logger.info(
        {
          correlationId,
          reqId,
          count: page.data.length,
          hasNext: !!page.nextCursor,
        },
        "users_list_served",
      );

      // Strong ETag on the page payload; clients may revalidate.
      const responsePayload = { data: page.data, nextCursor: page.nextCursor };
      if (conditionalGet(responsePayload, req, res)) return;
      return res.json(responsePayload);
    } catch (e) {
      return next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/users/me
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user's own profile.
 *
 * Authentication: Bearer JWT via `requireAuthForbidden` middleware.
 * A missing or invalid token yields 403 Forbidden (not 401, per the existing
 * contract — changing this would be a breaking API change).
 *
 * Response:
 *   { data: CurrentUserProfile }
 *
 * Caching:
 *   Strong ETag on the profile payload; clients may revalidate with
 *   If-None-Match and receive 304 Not Modified when the profile is unchanged.
 *
 * Errors:
 *   403 forbidden — missing or invalid JWT
 *   404 not_found — user row deleted after token was issued (TOCTOU)
 */
usersRouter.get(
  "/me",
  requireAuthForbidden,
  usersRateLimit,
  async (req: AuthenticatedRequest, res, next) => {
    const correlationId =
      (res.locals.correlationId as string | undefined) ?? getRequestId();

    try {
      const userId = req.user!.id;
      const result = await getCurrentUserProfile(userId);

      if (!result.ok) {
        throw result.error;
      }

      const profile = result.value;
      logger.info(
        {
          correlationId,
          userId,
          stellarAddress: profile.stellarAddress,
          ...profile.totals,
        },
        "user_me_profile_loaded",
      );

      // Strong ETag on the profile payload; 304 if client already has it.
      const responsePayload = { data: profile };
      if (conditionalGet(responsePayload, req, res)) return;
      return res.json(responsePayload);
    } catch (e) {
      return next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/users/:address/predictions
// ---------------------------------------------------------------------------

/**
 * Returns a cursor-paginated list of predictions for the given Stellar address.
 *
 * Path parameters:
 *   - :address — a valid 56-char Stellar G-address
 *
 * Query parameters:
 *   - status  (optional) — filter by prediction status enum
 *   - cursor  (optional) — opaque base64url token from the previous page's `nextCursor`
 *   - limit   (optional, default 20, max 100) — page size
 *
 * Response:
 *   { data: UserPredictionRow[], nextCursor: string | null }
 *
 * Caching:
 *   Strong ETag on the page payload; clients may revalidate with If-None-Match
 *   and receive 304 Not Modified when the page is unchanged.
 *
 * Errors:
 *   400 invalid_address  — path param is not a valid G… Stellar address
 *   400 validation_error — query params fail the zod schema
 *   404 not_found        — no user row for that address
 */
usersRouter.get(
  "/:address/predictions",
  usersRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    // Prefer the access-log correlation ID; fall back to ALS for non-route callers.
    const correlationId =
      (res.locals.correlationId as string | undefined) ?? getRequestId();
    const reqId = correlationId;

    try {
      // Validate the path parameter :address at the route boundary before touching the DB.
      const paramsParse = userPredictionsParamsSchema.safeParse(req.params);
      if (!paramsParse.success) {
        logger.warn(
          {
            correlationId,
            reqId,
            address: req.params.address,
            issues: paramsParse.error.issues,
          },
          "predictions_invalid_address",
        );
        return res.status(400).json({
          error: {
            code: "invalid_address",
            message:
              paramsParse.error.issues[0]?.message ?? "invalid stellar address",
            requestId: reqId,
          },
        });
      }
      const { address } = paramsParse.data;

      // Validate and coerce query parameters with zod.
      const queryParse = userPredictionsQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        logger.warn(
          { correlationId, reqId, address, issues: queryParse.error.issues },
          "predictions_invalid_query",
        );
        return res.status(400).json({
          error: {
            code: "validation_error",
            message:
              queryParse.error.issues[0]?.message ?? "invalid query parameters",
            requestId: reqId,
          },
        });
      }
    const { status, cursor, limit: rawLimit } = queryParse.data;
    // clampLimit is a belt-and-suspenders guard; zod already enforces 1–100.
    const limit = clampLimit(rawLimit);

    logger.debug({ reqId, address, status, limit, hasCursor: !!cursor }, "predictions_request");

    const user = await getUserByAddress(address);
    if (!user) {
      logger.debug({ reqId, address }, "predictions_user_not_found");
      return res.status(404).json({ error: { code: "not_found", requestId: reqId } });
    }

    const page = await getUserPredictions(user.id, { status, limit, cursor });

    logger.info(
      { reqId, address, userId: user.id, count: page.data.length, hasNext: !!page.nextCursor },
      "predictions_page_served",
    );

    return res.json({ data: page.data, nextCursor: page.nextCursor });
  } catch (e) {
    return next(e);
  }
});

usersRouter.get(
  "/:stellarAddress/profile",
  async (req, res, next) => {
    const reqId = getRequestId();

    const parseResult = stellarAddressSchema.safeParse(req.params.stellarAddress);
    if (!parseResult.success) {
      logger.warn(
        { reqId, stellarAddress: req.params.stellarAddress, issues: parseResult.error.issues },
        "user_profile_validation_failed",
      );
      return next(
        RouteErrorFactory.badRequest(parseResult.error.issues[0]?.message ?? "invalid stellar address"),
      );
    }

    const stellarAddress = parseResult.data;

    try {
      logger.debug({ reqId, stellarAddress }, "user_profile_lookup");

      const profile = await getUserProfile(stellarAddress);

      if (!profile) {
        logger.debug({ reqId, stellarAddress }, "user_profile_not_found");
        throw RouteErrorFactory.notFound("no user found with that stellar address");
      }

      const { status, cursor, limit: rawLimit } = queryParse.data;
      // clampLimit is a belt-and-suspenders guard; zod already enforces 1–100.
      const limit = clampLimit(rawLimit);

      logger.debug(
        { correlationId, reqId, address, status, limit, hasCursor: !!cursor },
        "predictions_request",
      );

      const user = await getUserByAddress(address);
      if (!user) {
        logger.debug(
          { correlationId, reqId, address },
          "predictions_user_not_found",
        );
        return res
          .status(404)
          .json({ error: { code: "not_found", requestId: reqId } });
      }

      const page = await getUserPredictions(user.id, { status, limit, cursor });

      logger.info(
        {
          correlationId,
          reqId,
          address,
          userId: user.id,
          count: page.data.length,
          hasNext: !!page.nextCursor,
        },
        "predictions_page_served",
      );

      // Strong ETag on the page payload; 304 if client already has it.
      const responsePayload = { data: page.data, nextCursor: page.nextCursor };
      if (conditionalGet(responsePayload, req, res)) return;
      return res.json(responsePayload);
    } catch (e) {
      return next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/users/:stellarAddress/profile
// ---------------------------------------------------------------------------

/**
 * Returns the public profile for any registered Stellar address.
 *
 * Path parameters:
 *   - :stellarAddress — a valid 56-char Stellar G-address
 *
 * Response:
 *   { data: UserProfile }
 *
 * Caching:
 *   Strong ETag on the profile payload; clients may revalidate with
 *   If-None-Match and receive 304 Not Modified when the profile is unchanged.
 *
 * Errors:
 *   400 validation_error — path param is not a valid G… Stellar address
 *   404 not_found        — no user row for that address
 */
usersRouter.get(
  "/:stellarAddress/profile",
  usersRateLimit,
  async (req, res, next) => {
    const correlationId =
      (res.locals.correlationId as string | undefined) ?? getRequestId();
    const reqId = correlationId;

    const parseResult = userProfileParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      logger.warn(
        {
          correlationId,
          reqId,
          stellarAddress: req.params.stellarAddress,
          issues: parseResult.error.issues,
        },
        "user_profile_validation_failed",
      );
      // Use next() so the error flows through the global error handler.
      return next(
        RouteErrorFactory.validation(
          parseResult.error.issues[0]?.message ?? "invalid stellar address",
        ),
      );
    }

    const { stellarAddress } = parseResult.data;

    try {
      logger.debug(
        { correlationId, reqId, stellarAddress },
        "user_profile_lookup",
      );

      const profile = await getUserProfile(stellarAddress);

      if (!profile) {
        logger.debug(
          { correlationId, reqId, stellarAddress },
          "user_profile_not_found",
        );
        return next(
          RouteErrorFactory.notFound("no user found with that stellar address"),
        );
      }

      logger.info(
        {
          correlationId,
          reqId,
          stellarAddress,
        },
        "user_profile_found",
      );

      // Strong ETag on the profile payload; 304 if client already has it.
      const responsePayload = { data: profile };
      if (conditionalGet(responsePayload, req, res)) return;
      return res.json(responsePayload);
    } catch (err) {
      // Delegate to the global error handler which logs and returns a
      // standardised 500 envelope (including requestId).
      return next(err);
    }
  },
);
