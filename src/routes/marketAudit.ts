import { Router } from "express";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { markets, marketAuditLog } from "../db/schema";
import { clampLimit, decodeCursor, encodeCursor } from "../utils/cursor";
import { logger } from "../config/logger";
import { RouteErrorFactory } from "../errors";
import { startAuditSpan, endAuditSpan, recordErrorOnSpan } from "../otel/spans";

const auditQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z
      .string()
      .regex(/^\d+$/, { message: "limit must be a positive integer" })
      .optional(),
  })
  .strict();

export const marketAuditRouter = Router({ mergeParams: true });

marketAuditRouter.get("/", async (req, res, next) => {
  const span = startAuditSpan("audit.market.list", req, res);
  const reqId = String((req as { id?: string }).id ?? "anon");
  try {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw RouteErrorFactory.validation(parsed.error.issues[0]?.message ?? "invalid query parameters");
    }

    const marketId = (req.params as Record<string, string>).id;
    span.setAttribute("market.id", marketId);

    const exists = await db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);
    if (exists.length === 0) {
      throw RouteErrorFactory.notFound("Market not found");
    }

    const take = clampLimit(parsed.data.limit);
    const key = decodeCursor(parsed.data.cursor);

    const cursorPredicate = key
      ? or(
          lt(marketAuditLog.createdAt, new Date(key.sortValue)),
          and(
            eq(marketAuditLog.createdAt, new Date(key.sortValue)),
            lt(marketAuditLog.id, key.id),
          ),
        )
      : undefined;

    const rows = await db
      .select()
      .from(marketAuditLog)
      .where(
        cursorPredicate
          ? and(eq(marketAuditLog.marketId, marketId), cursorPredicate)
          : eq(marketAuditLog.marketId, marketId),
      )
      .orderBy(desc(marketAuditLog.createdAt), desc(marketAuditLog.id))
      .limit(take + 1);

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    const last = data[data.length - 1];

    logger.info({ reqId, marketId, count: data.length }, "market_audit_listed");

    endAuditSpan(span, res);
    return res.json({
      data,
      nextCursor:
        hasMore && last
          ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
          : null,
    });
  } catch (err) {
    recordErrorOnSpan(span, err);
    return next(err);
  }
});
