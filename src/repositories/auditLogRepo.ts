import { and, count, desc, eq, lt, or, gte, lte } from "drizzle-orm";
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




/**
 * Stream audit logs matching the given filter criteria using an async generator.
 *
 * Fetches all matching records from the database and yields them one by one.
 * For very large datasets, consider implementing cursor-based batching.
 *
 * @param filters - Filter criteria (without pagination fields)
 * @returns An async generator yielding AuditLogItem objects
 */
export async function* getAuditLogsStream(
  filters: Omit<AuditLogFilters, 'cursor' | 'limit'>,
): AsyncGenerator<AuditLogItem, void, undefined> {
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

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));

  for (const row of rows) {
    yield row as AuditLogItem;
  }
}

/**
 * Retrieve a paginated list of audit logs for a specific wallet address.
 * Uses the same keyset pagination as `getAuditLogs`, but always pins the
 * `walletAddress` filter so callers cannot omit it.
 */
export async function getAuditLogsByUser(
  walletAddress: string,
  filters: Omit<AuditLogFilters, "actor">,
): Promise<Page<AuditLogItem>> {
  const take = clampLimit(filters.limit);
  const key = decodeCursor(filters.cursor);

  const cursorPredicate = key
    ? or(
        lt(auditLogs.createdAt, new Date(key.sortValue)),
        and(
          eq(auditLogs.createdAt, new Date(key.sortValue)),
          lt(auditLogs.id, key.id),
        ),
      )
    : undefined;

  const conditions = [eq(auditLogs.walletAddress, walletAddress)];

  if (filters.action) {
    conditions.push(eq(auditLogs.action, filters.action));
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

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conditions))
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

export interface AuditActionCount {
  action: string;
  count: number;
}

export interface AuditCountsSummary {
  totalCount: number;
  byAction: AuditActionCount[];
}

/**
 * Aggregate audit log entries into a per-action counts summary, optionally
 * scoped to a date range. Used to power admin dashboards without requiring
 * the full paginated log to be fetched and counted client-side.
 */
export async function getAuditCounts(
  filters: Pick<AuditLogFilters, "startDate" | "endDate">,
): Promise<AuditCountsSummary> {
  const conditions = [];
  if (filters.startDate) {
    conditions.push(gte(auditLogs.createdAt, filters.startDate));
  }
  if (filters.endDate) {
    conditions.push(lte(auditLogs.createdAt, filters.endDate));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const countExpr = count();

  const rows = await db
    .select({ action: auditLogs.action, count: countExpr })
    .from(auditLogs)
    .where(whereClause)
    .groupBy(auditLogs.action)
    .orderBy(desc(countExpr));

  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);

  return {
    totalCount,
    byAction: rows.map((row) => ({ action: row.action, count: row.count })),
  };
}
