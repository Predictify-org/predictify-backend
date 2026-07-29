import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/requireAdmin";
import { conditionalGet } from "../middleware/etag";
import { getAuditLogs } from "../repositories/auditLogRepo";
import { getRequestId } from "../lib/requestContext";
import { logger } from "../config/logger";
import { rateLimitStatusRouter } from "./rate-limit/status";
import { rateLimitRequestDuration } from "../metrics/registry";

export const rateLimitRouter = Router();

const rateLimitQuerySchema = z.object({
  cursor: z.string().min(1, { message: "cursor must not be empty when provided" }).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { message: "limit must be a positive integer" })
    .optional(),
});

/**
 * Records request latency for /api/rate-limit into the
 * `rate_limit_request_duration_seconds` histogram (see metrics/registry.ts),
 * segmented by route template and status code.
 *
 * Registered ahead of auth so that latency for rejected requests (e.g. 401)
 * is captured as well, not just successful 200s.
 */
function rateLimitMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const route: string = req.route?.path || req.path;
    const status = String(res.statusCode);

    rateLimitRequestDuration.observe({ route, status }, durationSec);
  });

  next();
}

rateLimitRouter.use(rateLimitMetricsMiddleware);
rateLimitRouter.use(rateLimitStatusRouter);

rateLimitRouter.get("/", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const reqId = getRequestId();

  try {
    const parsed = rateLimitQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      logger.warn(
        {
          reqId,
          adminAddress: req.adminAddress,
          issues: parsed.error.issues,
        },
        "rate_limit_list_validation_failed",
      );

      return res.status(400).json({
        error: {
          code: "validation_error",
          message: parsed.error.issues[0]?.message ?? "invalid query parameters",
          requestId: reqId,
        },
      });
    }

    const limit = parsed.data.limit ? Number.parseInt(parsed.data.limit, 10) : undefined;
    const page = await getAuditLogs({
      action: "rate_limit.blocked",
      cursor: parsed.data.cursor,
      limit,
    });

    logger.info(
      {
        reqId,
        adminAddress: req.adminAddress,
        count: page.data.length,
        hasNext: page.nextCursor !== null,
      },
      "rate_limit_listed",
    );

    const responsePayload = { data: page.data, nextCursor: page.nextCursor };
    if (conditionalGet(responsePayload, req, res)) return;
    return res.json(responsePayload);
  } catch (err) {
    return next(err);
  }
});
