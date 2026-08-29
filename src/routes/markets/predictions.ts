/**
 * GET /api/markets/:id/predictions
 *
 * Public endpoint that returns cursor-paginated predictions for a specific market.
 * No authentication required.
 *
 * Query parameters:
 *   - status   (optional) — filter by prediction status (pending, confirmed, won, lost, claimed)
 *   - outcome  (optional) — filter by outcome (e.g. "yes" / "no")
 *   - cursor   (optional) — opaque token from the previous page's `nextCursor`
 *   - limit    (optional, default 20, max 100) — page size
 *
 * Response:
 *   200 { data: PredictionRow[], nextCursor: string | null }
 *   404 Market not found
 *   400 Validation error
 */

import { Router } from "express";
import { and, eq, desc, lt, or } from "drizzle-orm";
import { db } from "../../db/client";
import { markets, predictions } from "../../db/schema";
import { decodeCursor, encodeCursor, clampLimit } from "../../utils/cursor";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";
import { RouteErrorFactory } from "../../errors";
import { conditionalGet } from "../../middleware/etag";
import { requestTimeout } from "../../middleware/timeout";
import { listMarketPredictionsQuerySchema } from "../../validators/predictions";
import type { Request, Response, NextFunction } from "express";

export const predictionsRouter = Router();

// ── Timeout middleware ────────────────────────────────────────────────
predictionsRouter.use(requestTimeout(10000));

/**
 * GET /api/markets/:id/predictions
 */
predictionsRouter.get(
  "/:id/predictions",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const reqId = getRequestId();
    const marketId = req.params.id;

    try {
      // ── Validate market exists ──────────────────────────────────────
      const [market] = await db
        .select({ id: markets.id })
        .from(markets)
        .where(eq(markets.id, marketId))
        .limit(1);

      if (!market) {
        throw RouteErrorFactory.notFound(`Market with ID ${marketId} not found`);
      }

      // ── Parse and validate query parameters ──────────────────────────
      const queryParse = listMarketPredictionsQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        logger.warn(
          { reqId, marketId, issues: queryParse.error.issues },
          "market_predictions_list_invalid_query",
        );
        res.status(400).json({
          error: {
            code: "validation_error",
            message: queryParse.error.issues[0]?.message ?? "invalid query parameters",
            requestId: reqId,
          },
        });
        return;
      }

      const { status, outcome, cursor, limit: rawLimit } = queryParse.data;
      const limit = clampLimit(rawLimit);

      // ── Build WHERE conditions ──────────────────────────────────────
      const conditions = [eq(predictions.marketId, marketId)];

      if (status) {
        conditions.push(eq(predictions.status, status));
      }

      if (outcome) {
        conditions.push(eq(predictions.outcome, outcome));
      }

      // ── Decode cursor ──────────────────────────────────────────────
      const cursorKey = decodeCursor(cursor);
      if (cursorKey) {
        const cursorTime = new Date(cursorKey.sortValue);
        conditions.push(
          or(
            lt(predictions.createdAt, cursorTime),
            and(
              eq(predictions.createdAt, cursorTime),
              lt(predictions.id, cursorKey.id),
            ),
          )!,
        );
      }

      // ── Execute query ──────────────────────────────────────────────
      const rows = await db
        .select({
          id: predictions.id,
          marketId: predictions.marketId,
          userId: predictions.userId,
          outcome: predictions.outcome,
          amount: predictions.amount,
          txHash: predictions.txHash,
          status: predictions.status,
          result: predictions.result,
          createdAt: predictions.createdAt,
        })
        .from(predictions)
        .where(and(...conditions))
        .orderBy(desc(predictions.createdAt), desc(predictions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit);

      // ── Mint next cursor ────────────────────────────────────────────
      const last = data[data.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              sortValue: last.createdAt.toISOString(),
              id: last.id,
            })
          : null;

      // ── Serialize response ──────────────────────────────────────────
      const payload = {
        data: data.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor,
      };

      // ── ETag handling ────────────────────────────────────────────────
      if (conditionalGet(payload, req, res)) {
        return;
      }

      logger.info(
        { reqId, marketId, count: data.length, hasNext: !!nextCursor },
        "market_predictions_list_success",
      );

      res.status(200).json(payload);
    } catch (err) {
      if (err instanceof Error && (err as { status?: number }).status === 404) {
        logger.warn({ reqId, marketId }, "market_predictions_list_not_found");
        res.status(404).json({
          error: {
            code: "not_found",
            message: `Market with ID ${marketId} not found`,
            requestId: reqId,
          },
        });
        return;
      }
      logger.error(
        { reqId, marketId, err },
        "market_predictions_list_failed",
      );
      next(err);
    }
  },
);