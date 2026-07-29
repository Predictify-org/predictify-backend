import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getAuditLogs } from "../../../repositories/auditLogRepo";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import { startAuditSpan, endAuditSpan, recordErrorOnSpan } from "../../../otel/spans";

const searchAuditSchema = z.object({
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
  limit: z.number().int().positive({ message: "limit must be a positive integer" }).optional(),
});

/**
 * POST /api/admin/audit/search
 * Searches admin audit log by action or actor.
 */
export const searchAuditLogsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const span = startAuditSpan("audit.admin.search", req, res);
  try {
    const parseResult = searchAuditSchema.safeParse(req.body);
    const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

    if (!parseResult.success) {
      res.status(400);
      endAuditSpan(span, res);
      res.json({
        error: {
          code: "validation_error",
          message: parseResult.error.issues[0]?.message ?? "invalid payload parameters",
          requestId: reqId,
        },
      });
      return;
    }

    const filters = parseResult.data;

    // Structured logging with correlation IDs
    logger.info(
      {
        actionFilter: filters.action,
        actorFilter: filters.actor,
        correlationId: reqId,
      },
      "Searching admin audit logs",
    );

    const page = await getAuditLogs(filters);

    endAuditSpan(span, res);
    res.json({
      data: page.data,
      nextCursor: page.nextCursor,
    });
  } catch (e) {
    recordErrorOnSpan(span, e);
    next(e);
  }
};
