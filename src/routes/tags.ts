import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { accessLog } from "../middleware/accessLog";
import { logger } from "../config/logger";
import { getMarketTags } from "../repositories/marketRepository";
import { abortableRace, requestTimeout, RequestAbortedError } from "../middleware/timeout";

export const tagsRouter = Router();
tagsRouter.use(accessLog);

const TAGS_TIMEOUT_MS = 5000;

tagsRouter.use(
  requestTimeout(TAGS_TIMEOUT_MS, {
    statusCode: 504,
    code: "gateway_timeout",
    message: "Tags request timed out",
  }),
);

const tagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * @openapi
 * /api/tags:
 *   get:
 *     summary: Retrieve system tags
 *     description: Returns a list of tags. Used to test the tags access log. The request is bounded by a per-request timeout and returns 504 if the backing read exceeds the deadline.
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
 *       504:
 *         description: Tags lookup exceeded the per-request timeout
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
tagsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  const reqId = String((req as Request & { id?: unknown }).id ?? "anon");
  const signal = res.locals.abortSignal as { aborted: boolean; addEventListener: (...args: unknown[]) => void; removeEventListener: (...args: unknown[]) => void } | undefined;

  try {
    const parsed = tagsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { limit } = parsed.data;

    logger.debug({ reqId, correlationId: reqId, limit }, "Fetching system tags");

    const data = await abortableRace(getMarketTags(), signal);
    const tags = data.map((d) => d.tag).slice(0, limit);

    logger.info({ reqId, correlationId: reqId, count: tags.length }, "System tags fetched successfully");

    res.json({ tags });
  } catch (e) {
    if (e instanceof RequestAbortedError) {
      logger.warn(
        { correlationId: reqId, path: req.path },
        "Abandoned /api/tags request after timeout",
      );
      return;
    }

    logger.error({ reqId, correlationId: reqId, err: e }, "Failed to fetch system tags");
    next(e);
  }
});
