import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getAuditLogs } from "../../../repositories/auditLogRepo";
import { RouteErrorFactory } from "../../../errors";

export interface AdminAuditRouterOptions {
  rateLimitPerMinute?: number;
}

const auditQuerySchema = z.object({
  action: z.string().optional(),
  actor: z.string().optional(),
  startDate: z.string()
    .datetime({ message: "startDate must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
  endDate: z.string()
    .datetime({ message: "endDate must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
  cursor: z.string().optional(),
  limit: z.string()
    .regex(/^\d+$/, { message: "limit must be a positive integer" })
    .transform((val) => parseInt(val, 10))
    .optional(),
});

export function createAdminAuditRouter(opts: AdminAuditRouterOptions = {}): Router {
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

  router.get("/", async (req, res, next) => {
    try {
      const parseResult = auditQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw RouteErrorFactory.validation(
          parseResult.error.issues[0]?.message ?? "invalid query parameters",
        );
      }

      const filters = parseResult.data;
      const page = await getAuditLogs(filters);

      res.json({
        data: page.data,
        nextCursor: page.nextCursor,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const adminAuditRouter = createAdminAuditRouter();
