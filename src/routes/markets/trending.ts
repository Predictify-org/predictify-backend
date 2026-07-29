import { Router } from "express";
import { getTrending } from "../../services/trendingService";
import { rateLimitAnon } from "../../middleware/rateLimitAnon";
import { trendingQuerySchema } from "../../validators/markets";
import { conditionalGet } from "../../middleware/etag";

export const trendingRouter = Router();

trendingRouter.use(rateLimitAnon);

// GET /api/markets/trending - Get trending markets
trendingRouter.get("/", async (req, res, next) => {
  try {
    const { limit, offset } = trendingQuerySchema.parse(req.query);
    const data = await getTrending(limit, offset);
    const payload = { data, meta: { limit, offset, count: data.length } };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    res.json(payload);
  } catch (e) {
    next(e);
  }
});
