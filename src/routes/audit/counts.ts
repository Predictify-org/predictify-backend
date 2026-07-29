import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { getAuditCounts } from "../../repositories/auditLogRepo";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";

export interface AuditCountsRouterOptions {
  rateLimitPerMinute?: number;
}

const auditCountsQuerySchema = z.object({
  startDate: z.string()
    .datetime({ message: "startDate must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
  endDate: z.string()
    .datetime({ message: "endDate must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
});

export function createAuditCountsRouter(opts: AuditCountsRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  router.use(requireAdmin);

  /**
   * GET /api/audit/counts
   * Returns a per-action counts summary of audit log entries, optionally
   * scoped to a date range, for admin dashboards.
   */
  router.get("/", async (req, res, next) => {
    const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

    try {
      const parseResult = auditCountsQuerySchema.safeParse(req.query);

      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: parseResult.error.issues[0]?.message ?? "invalid query parameters",
            requestId: reqId,
          },
        });
        return;
      }

      const filters = parseResult.data;

      logger.info(
        {
          startDate: filters.startDate,
          endDate: filters.endDate,
          correlationId: reqId,
        },
        "Fetching admin audit counts summary",
      );

      const summary = await getAuditCounts(filters);

      res.json({ data: summary });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const auditCountsRouter = createAuditCountsRouter();
