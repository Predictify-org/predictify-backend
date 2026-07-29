import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { accessLog } from "../middleware/accessLog";
import { logger } from "../config/logger";
import { getMarketTags } from "../repositories/marketRepository";

export const tagsRouter = Router();
tagsRouter.use(accessLog);

const tagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * @openapi
 * /api/tags:
 *   get:
 *     summary: Retrieve system tags
 *     description: Returns a list of tags. Used to test the tags access log.
 *     tags:
 *       - Tags
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Maximum number of tags to return
 *     responses:
 *       200:
 *         description: A list of tags
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
tagsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  const reqId = String((req as any).id ?? "anon");
  try {
    const parsed = tagsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { limit } = parsed.data;

    logger.debug({ reqId, correlationId: reqId, limit }, "Fetching system tags");
    
    const data = await getMarketTags();
    const tags = data.map((d) => d.tag).slice(0, limit);
    
    logger.info({ reqId, correlationId: reqId, count: tags.length }, "System tags fetched successfully");
    
    res.json({ tags });
  } catch (e) {
    logger.error({ reqId, correlationId: reqId, err: e }, "Failed to fetch system tags");
    next(e);
  }
});
