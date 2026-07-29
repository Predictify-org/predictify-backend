/**
 * watchers.ts
 *
 * GET    /api/markets/:id/watchers - List subscribers/watchers of a market
 * POST   /api/markets/:id/watchers - Add authenticated user as a watcher of a market
 * DELETE /api/markets/:id/watchers - Remove authenticated user from market watchers
 *
 * Responses:
 *   200 – { data: WatcherRow[], nextCursor: string | null, total: number }
 *   400 – Validation error (invalid market ID or query parameters)
 *   401 – Unauthorized (for POST and DELETE)
 *   404 – Market not found
 *   500 – Unexpected server error
 */

import { Router } from "express";
import { conditionalGet } from "../../middleware/etag";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";
import { AuthenticatedRequest } from "../../middleware/auth";
import { requireAuth } from "../../middleware/requireAuth";
import {
  listMarketWatchers,
  addMarketWatcher,
  removeMarketWatcher,
} from "../../services/marketWatcherService";
import { NotFoundError } from "../../errors";
import {
  marketParamsSchema,
  marketWatchersQuerySchema,
} from "../../validators/markets";

export const watchersRouter = Router({ mergeParams: true });

/**
 * GET /api/markets/:id/watchers
 * Lists watchers/subscribers of the specified market.
 */
watchersRouter.get("/", async (req, res, next) => {
  const reqId = getRequestId() ?? String((req as { id?: unknown }).id ?? "anon");

  try {
    const paramsParsed = marketParamsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      logger.warn({ reqId, correlationId: reqId, issues: paramsParsed.error.issues }, "market_watchers_invalid_params");
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: paramsParsed.error.issues[0]?.message ?? "Invalid market ID",
          requestId: reqId,
        },
      });
    }

    const queryParsed = marketWatchersQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      logger.warn({ reqId, correlationId: reqId, issues: queryParsed.error.issues }, "market_watchers_invalid_query");
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: queryParsed.error.issues[0]?.message ?? "Invalid query parameters",
          requestId: reqId,
        },
      });
    }

    const { id: marketId } = paramsParsed.data;
    const { limit, cursor } = queryParsed.data;

    logger.debug({ reqId, correlationId: reqId, marketId, limit, cursor }, "market_watchers_list_request");

    const result = await listMarketWatchers(marketId, { limit, cursor });
    const payload = {
      data: result.data,
      nextCursor: result.nextCursor,
      total: result.total,
    };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    logger.info(
      {
        reqId,
        correlationId: reqId,
        marketId,
        count: result.data.length,
        total: result.total,
        hasNext: !!result.nextCursor,
      },
      "market_watchers_list_success",
    );

    return res.status(200).json(payload);
  } catch (err) {
    if (err instanceof NotFoundError) {
      logger.warn({ reqId, correlationId: reqId, marketId: req.params.id }, "market_watchers_not_found");
      return res.status(404).json({
        error: {
          code: "not_found",
          message: (err as Error).message,
          requestId: reqId,
        },
      });
    }

    logger.error({ reqId, correlationId: reqId, marketId: req.params.id, err }, "market_watchers_list_failed");
    return next(err);
  }
});

/**
 * POST /api/markets/:id/watchers
 * Adds the authenticated user to the market's watchers list.
 */
watchersRouter.post("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  const reqId = getRequestId() ?? String((req as { id?: unknown }).id ?? "anon");

  try {
    const paramsParsed = marketParamsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      logger.warn({ reqId, correlationId: reqId, issues: paramsParsed.error.issues }, "market_watcher_add_invalid_params");
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: paramsParsed.error.issues[0]?.message ?? "Invalid market ID",
          requestId: reqId,
        },
      });
    }

    const { id: marketId } = paramsParsed.data;
    const userId = req.user!.id;

    logger.info({ reqId, correlationId: reqId, marketId, userId }, "market_watcher_add_request");

    const watcher = await addMarketWatcher(marketId, userId);

    logger.info({ reqId, correlationId: reqId, marketId, userId, watcherId: watcher.id }, "market_watcher_add_success");

    return res.status(201).json({
      data: watcher,
      message: "Successfully subscribed as a watcher of this market",
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      logger.warn({ reqId, correlationId: reqId, marketId: req.params.id }, "market_watcher_add_not_found");
      return res.status(404).json({
        error: {
          code: "not_found",
          message: (err as Error).message,
          requestId: reqId,
        },
      });
    }

    logger.error({ reqId, correlationId: reqId, marketId: req.params.id, err }, "market_watcher_add_failed");
    return next(err);
  }
});

/**
 * DELETE /api/markets/:id/watchers
 * Removes the authenticated user from the market's watchers list.
 */
watchersRouter.delete("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  const reqId = getRequestId() ?? String((req as { id?: unknown }).id ?? "anon");

  try {
    const paramsParsed = marketParamsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      logger.warn({ reqId, correlationId: reqId, issues: paramsParsed.error.issues }, "market_watcher_remove_invalid_params");
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: paramsParsed.error.issues[0]?.message ?? "Invalid market ID",
          requestId: reqId,
        },
      });
    }

    const { id: marketId } = paramsParsed.data;
    const userId = req.user!.id;

    logger.info({ reqId, correlationId: reqId, marketId, userId }, "market_watcher_remove_request");

    await removeMarketWatcher(marketId, userId);

    logger.info({ reqId, correlationId: reqId, marketId, userId }, "market_watcher_remove_success");

    return res.status(200).json({
      message: "Successfully unsubscribed from market watchers",
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      logger.warn({ reqId, correlationId: reqId, marketId: req.params.id }, "market_watcher_remove_not_found");
      return res.status(404).json({
        error: {
          code: "not_found",
          message: (err as Error).message,
          requestId: reqId,
        },
      });
    }

    logger.error({ reqId, correlationId: reqId, marketId: req.params.id, err }, "market_watcher_remove_failed");
    return next(err);
  }
});
