import { Router } from "express";
import { getRecommendedMarkets } from "../../services/marketService";
import { requireAuth } from "../../middleware/requireAuth";
import { logger } from "../../config/logger";
import { AuthenticatedRequest } from "../../middleware/auth";
import { recommendationsQuerySchema } from "../../validators/markets";
import { conditionalGet } from "../../middleware/etag";

export const recommendationsRouter = Router();

type RequestWithId = AuthenticatedRequest & { id?: string };

recommendationsRouter.get("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  const reqId = String((req as RequestWithId).id ?? "anon");
  try {
    const parsedQuery = recommendationsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw parsedQuery.error;
    }

    const { limit, cursor } = parsedQuery.data;
    const userId = req.user!.id;

    logger.info({ reqId, correlationId: reqId, userId, limit, hasCursor: !!cursor }, "markets_recommendations_requested");

    const page = await getRecommendedMarkets(userId, { limit, cursor });

    if (conditionalGet(page, req, res)) {
      return;
    }

    // Return a clear pagination envelope so clients never need to guess
    // which field holds the items or the cursor.
    const body: Record<string, unknown> = {
      items: page.data,
      next_cursor: page.nextCursor,
    };
    if (page.total !== undefined) {
      body.total = page.total;
    }
    return res.status(200).json(body);
  } catch (err) {
    logger.error({ reqId, correlationId: reqId, err }, "markets_recommendations_failed");
    return next(err);
  }
});

