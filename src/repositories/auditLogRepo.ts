import { and, desc, eq, lt, or, gte, lte } from "drizzle-orm";
import { db } from "../db";
import { auditLogs } from "../db/schema";
import { clampLimit, decodeCursor, encodeCursor, type Page } from "../utils/cursor";

export interface AuditLogFilters {
  action?: string;
  actor?: string;
  startDate?: Date;
  endDate?: Date;
  cursor?: string;
  limit?: number;
}

export interface AuditLogItem {
  id: string;
  action: string;
  walletAddress: string | null;
  ip: string;
  correlationId: string;
  rateLimitContext: unknown;
  createdAt: Date;
}

/**
 * Retrieve a paginated list of audit logs matching the given filter criteria.
 * Uses cursor/keyset pagination (DESC by createdAt, then id) for stability.
 */
export async function getAuditLogs(filters: AuditLogFilters): Promise<Page<AuditLogItem>> {
  const take = clampLimit(filters.limit);
  const key = decodeCursor(filters.cursor);

  // Keyset predicate for DESC (createdAt, id)
  const cursorPredicate = key
    ? or(
        lt(auditLogs.createdAt, new Date(key.sortValue)),
        and(
          eq(auditLogs.createdAt, new Date(key.sortValue)),
          lt(auditLogs.id, key.id),
        ),
      )
    : undefined;

  const conditions = [];
  if (filters.action) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (filters.actor) {
    conditions.push(eq(auditLogs.walletAddress, filters.actor));
  }
  if (filters.startDate) {
    conditions.push(gte(auditLogs.createdAt, filters.startDate));
  }
  if (filters.endDate) {
    conditions.push(lte(auditLogs.createdAt, filters.endDate));
  }
  if (cursorPredicate) {
    conditions.push(cursorPredicate);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(take + 1);

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;
  const last = data[data.length - 1];

  return {
    data: data as AuditLogItem[],
    nextCursor:
      hasMore && last
        ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}
