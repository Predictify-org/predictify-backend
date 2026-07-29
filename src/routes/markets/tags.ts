/* eslint-disable @typescript-eslint/no-explicit-any */
import { Router } from "express";
import { getMarketTags } from "../../repositories/marketRepository";
import { rateLimitAnon } from "../../middleware/rateLimitAnon";
import { conditionalGet } from "../../middleware/etag";
import { logger } from "../../config/logger";

export const tagsRouter = Router();

tagsRouter.use(rateLimitAnon);

// GET /api/markets/tags - Get market tags with counts
tagsRouter.get("/", async (req, res, next) => {
  const reqId = String((req as any).id ?? "anon");
  try {
    logger.debug({ reqId, correlationId: reqId }, "Fetching market tags");
    const data = await getMarketTags();
    const payload = { data };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    logger.info({ reqId, correlationId: reqId, count: data.length }, "Market tags fetched successfully");
    res.json(payload);
  } catch (e) {
    logger.error({ reqId, correlationId: reqId, err: e }, "Failed to fetch market tags");
    next(e);
  }
});
