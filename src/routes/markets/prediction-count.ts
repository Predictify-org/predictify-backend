/**
 * prediction-count.ts
 *
 * GET /api/markets/:id/prediction-count
 *
 * Returns the total number of predictions placed on a market.
 * The count is cached in Redis for 60 seconds to avoid repeated DB queries.
 *
 * Responses:
 *   200 – { data: { marketId, count, computedAt, cached } }
 *   400 – market ID is empty or not a string
 *   404 – market not found
 *   500 – unexpected server error
 *
 * This route uses `mergeParams: true` so the `:id` param injected by the
 * parent marketsRouter is available here.
 */

import { Router } from "express";
import { getPredictionCount } from "../../services/predictionCountService";
import { NotFoundError } from "../../errors";
import { conditionalGet } from "../../middleware/etag";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";

export const predictionCountRouter = Router({ mergeParams: true });

predictionCountRouter.get("/", async (req, res, next) => {
  const reqId = getRequestId() ?? String((req as { id?: unknown }).id ?? "anon");
  const marketId = (req.params as Record<string, string>).id;

  // Input guard – the parent router always supplies :id but be explicit
  if (!marketId || typeof marketId !== "string" || !marketId.trim()) {
    logger.warn({ reqId, marketId }, "prediction_count_invalid_id");
    return res.status(400).json({
      error: {
        code: "validation_error",
        message: "Market ID is required",
        requestId: reqId,
      },
    });
  }

  try {
    logger.debug({ reqId, marketId }, "prediction_count_request");

    const result = await getPredictionCount(marketId);
    const payload = { data: result };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    logger.info(
      { reqId, marketId, count: result.count, cached: result.cached },
      "prediction_count_success",
    );

    return res.status(200).json(payload);
  } catch (err) {
    if (err instanceof NotFoundError) {
      logger.warn({ reqId, marketId }, "prediction_count_not_found");
      return res.status(404).json({
        error: {
          code: "not_found",
          message: (err as Error).message,
          requestId: reqId,
        },
      });
    }

    logger.error({ reqId, marketId, err }, "prediction_count_failed");
    return next(err);
  }
});
