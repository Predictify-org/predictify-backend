import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { getAuditLogs } from "../../repositories/auditLogRepo";
import { getRequestId } from "../../lib/requestContext";

export interface AdminAuditRouterOptions {
  /** Requests per minute per admin token. Default: 60 */
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

  // ── Rate limiter ────────────────────────────────────────────────────────────
  // Key on the raw Authorization header so each distinct admin token gets its
  // own bucket. Falls back to IP for unauthenticated requests so they are
  // still throttled before reaching requireAdmin.
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

  // ── Admin guard ─────────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── GET / ───────────────────────────────────────────────────────────────────
  router.get("/", async (req, res, next) => {
    try {
      const parseResult = auditQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        const reqId = getRequestId();
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

// Default export wired into src/index.ts
export const adminAuditRouter = createAdminAuditRouter();
