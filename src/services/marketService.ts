/* eslint-disable @typescript-eslint/no-explicit-any */
import { invalidateMarketCache } from "../cache/marketsCache";
import { db, getDb } from "../db/client";
import { markets, marketAuditLog, predictions } from "../db/schema";
import { and, asc, eq, inArray, desc, notInArray, sql, or, lt } from "drizzle-orm";
import { emitMarketEvent, LogEvent } from "../logging/events";
import { decodeCursor, encodeCursor, type Page } from "../utils/cursor";

export interface Market {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  metadata: any;
  indexedLedger: number;
  archived: boolean;
  version: number;
}

export class VersionConflictError extends Error {
  status = 409;
  code = "version_conflict";
  constructor() {
    super("Version conflict");
    Object.setPrototypeOf(this, VersionConflictError.prototype);
  }
}

export class MarketAlreadyExistsError extends Error {
  status = 409;
  code = "market_exists";
  constructor(marketId: string) {
    super(`Market with ID "${marketId}" already exists`);
    Object.setPrototypeOf(this, MarketAlreadyExistsError.prototype);
  }
}

/** Statuses that represent a market that has not yet opened for predictions. */
export const UPCOMING_MARKET_STATUSES = ["upcoming", "pending", "scheduled"] as const;

/**
 * Lists non-archived markets with cursor pagination.
 *
 * Sort order: (createdAt DESC, id DESC) - newest markets first, with the
 * unique id tie-breaker providing stable ordering within the same timestamp.
 *
 * Keyset WHERE predicate for DESC ordering:
 *   (createdAt < cursorTime)
 *   OR (createdAt = cursorTime AND id < cursorId)
 *
 * @param options.limit - Number of results to return (default: 20, max: 100)
 * @param options.cursor - Opaque cursor token from the previous page's nextCursor
 * @returns Page of markets formatted with ISO timestamps
 * @throws Error if database query fails
 */
export async function listMarkets(
  options: { limit?: number; cursor?: string } = {},
): Promise<Page<{
  id: string;
  question: string;
  status: string;
  resolutionTime: string;
}>> {
  const limit = options.limit ?? 20;
  const cursor = options.cursor;

  // Build WHERE conditions - always exclude archived markets.
  const conditions = [eq(markets.archived, false)];

  // Decode cursor and append keyset predicate for DESC (createdAt, id).
  const cursorKey = decodeCursor(cursor);
  if (cursorKey) {
    const cursorTime = new Date(cursorKey.sortValue);
    conditions.push(
      or(
        lt(markets.createdAt, cursorTime),
        and(
          eq(markets.createdAt, cursorTime),
          lt(markets.id, cursorKey.id),
        ),
      )!,
    );
  }

  // Fetch limit+1 rows so we can detect whether a next page exists.
  const rows = await getDb()
    .select({
      id: markets.id,
      question: markets.question,
      status: markets.status,
      resolutionTime: markets.resolutionTime,
      createdAt: markets.createdAt,
    })
    .from(markets)
    .where(and(...conditions))
    .orderBy(desc(markets.createdAt), desc(markets.id))
    .limit(limit + 1);

  if (!Array.isArray(rows)) {
    throw new Error("Unexpected response from database: rows is not an array");
  }

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  // Mint next-page cursor from the last row on this page.
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sortValue: last.createdAt.toISOString(),
          id: last.id,
        })
      : null;

  return {
    data: data.map((r) => ({
      id: r.id,
      question: r.question,
      status: r.status,
      resolutionTime:
        r.resolutionTime instanceof Date
          ? r.resolutionTime.toISOString()
          : r.resolutionTime,
    })),
    nextCursor,
  };
}

/**
 * Retrieves a single market by ID.
 *
 * @param id - The market ID to fetch
 * @returns Market object with formatted timestamp, or null if not found
 * @throws Error if database query fails
 */
export async function getMarketById(id: string) {
  if (!id || typeof id !== "string") {
    throw new Error("Market ID must be a non-empty string");
  }

  const rows = await getDb()
    .select({
      id: markets.id,
      question: markets.question,
      status: markets.status,
      resolutionTime: markets.resolutionTime,
      version: markets.version,
    })
    .from(markets)
    .where(eq(markets.id, id))
    .limit(1);

  if (!Array.isArray(rows)) {
    throw new Error("Unexpected response from database: rows is not an array");
  }

  if (rows.length === 0) {
    return null;
  }

  const r = rows[0];
  return {
    ...r,
    resolutionTime:
      r.resolutionTime instanceof Date
        ? r.resolutionTime.toISOString()
        : r.resolutionTime,
  };
}

/**
 * Lists upcoming markets — markets that are queued to be created/opened from
 * oracle events but are not yet active. Results are ordered by soonest resolution time first.
 */
export async function listUpcomingMarkets(
  options: { limit?: number; now?: Date } = {},
): Promise<any[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await getDb()
    .select({
      id: markets.id,
      question: markets.question,
      status: markets.status,
      resolutionTime: markets.resolutionTime,
    })
    .from(markets)
    .where(
      and(
        eq(markets.archived, false),
        or(
          eq(markets.status, "upcoming"),
          inArray(markets.status, UPCOMING_MARKET_STATUSES as unknown as string[]),
        ),
      ),
    )
    .orderBy(asc(markets.resolutionTime), asc(markets.id))
    .limit(limit);

  // Fail closed — never silently return [] (residual stub / bypass anti-pattern).
  if (!Array.isArray(rows)) {
    throw new Error("Unexpected response from database: rows is not an array");
  }

  return rows.map((r: any) => ({
    ...r,
    resolutionTime:
      r.resolutionTime instanceof Date ? r.resolutionTime.toISOString() : r.resolutionTime,
  }));
}

export async function getRecommendedMarkets(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<Page<any>> {
  const limit = options.limit ?? 20;
  const cursorKey = decodeCursor(options.cursor);
  const cursorTime = cursorKey ? new Date(cursorKey.sortValue) : null;
  const validCursorTime = cursorTime && !isNaN(cursorTime.getTime()) ? cursorTime : null;

  const cursorCondition =
    cursorKey && validCursorTime
      ? or(
          lt(markets.createdAt, validCursorTime),
          and(
            eq(markets.createdAt, validCursorTime),
            lt(markets.id, cursorKey.id),
          ),
        )
      : undefined;

  const userPredictions = await getDb()
    .select({ marketId: predictions.marketId })
    .from(predictions)
    .where(eq(predictions.userId, userId));

  const historyIds = userPredictions.map((p: { marketId: string }) => p.marketId);

  let rows: any[] = [];

  if (historyIds.length > 0) {
    const historyMarkets = await getDb()
      .select({ question: markets.question })
      .from(markets)
      .where(inArray(markets.id, historyIds));

    const keywords = historyMarkets
      .flatMap((m: { question: string }) => m.question.toLowerCase().split(/\W+/))
      .filter((w: string) => w.length > 3)
      .slice(0, 10);

    if (keywords.length > 0) {
      const keywordConditions = keywords.map((k: string) => sql`question ILIKE ${"%" + k + "%"}`);
      const whereConditions = [
        eq(markets.archived, false),
        eq(markets.status, "active"),
        notInArray(markets.id, historyIds),
        sql`(${sql.join(keywordConditions, sql` OR `)})`,
      ];
      if (cursorCondition) {
        whereConditions.push(cursorCondition);
      }

      rows = await getDb()
        .select({
          id: markets.id,
          question: markets.question,
          status: markets.status,
          resolutionTime: markets.resolutionTime,
          createdAt: markets.createdAt,
        })
        .from(markets)
        .where(and(...whereConditions))
        .orderBy(desc(markets.createdAt), desc(markets.id))
        .limit(limit + 1);
    }
  }

  if (rows.length === 0) {
    const whereConditions = [
      eq(markets.archived, false),
      eq(markets.status, "active"),
    ];
    if (historyIds.length > 0) {
      whereConditions.push(notInArray(markets.id, historyIds));
    }
    if (cursorCondition) {
      whereConditions.push(cursorCondition);
    }

    rows = await getDb()
      .select({
        id: markets.id,
        question: markets.question,
        status: markets.status,
        resolutionTime: markets.resolutionTime,
        createdAt: markets.createdAt,
      })
      .from(markets)
      .where(and(...whereConditions))
      .orderBy(desc(markets.createdAt), desc(markets.id))
      .limit(limit + 1);
  }

  const hasMore = rows.length > limit;
  const dataRows = rows.slice(0, limit);
  const lastRow = dataRows[dataRows.length - 1];

  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({
          sortValue:
            lastRow.createdAt instanceof Date
              ? lastRow.createdAt.toISOString()
              : new Date(lastRow.createdAt).toISOString(),
          id: lastRow.id,
        })
      : null;

  return {
    data: dataRows.map((r: any) => ({
      id: r.id,
      question: r.question,
      status: r.status,
      resolutionTime:
        r.resolutionTime instanceof Date ? r.resolutionTime.toISOString() : r.resolutionTime,
      ...(r.createdAt ? { createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt } : {}),
    })),
    nextCursor,
  };
}



/**
 * Updates a market with optimistic locking via version field.
 *
 * Performs transactional update with:
 * - Version conflict detection (409)
 * - Audit log creation
 * - Structured event emission
 *
 * @param id - Market ID
 * @param patch - Fields to update (question, metadata)
 * @param expectedVersion - Current version for optimistic locking
 * @param adminAddress - Stellar address of the admin making the change
 * @returns Updated market object
 * @throws VersionConflictError if version mismatch
 * @throws Error with status 404 if market not found
 */
export async function updateMarket(
  id: string,
  patch: { question?: string; metadata?: any },
  expectedVersion: number,
  adminAddress?: string,
): Promise<any> {
  if (!id || typeof id !== "string") {
    throw new Error("Market ID must be a non-empty string");
  }

  if (typeof expectedVersion !== "number" || expectedVersion < 0) {
    throw new Error("expectedVersion must be a non-negative number");
  }

  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);
    if (existing.length === 0) {
      const err = new Error("Market not found");
      (err as any).status = 404;
      throw err;
    }

    const currentMarket = existing[0];
    if (currentMarket.version !== expectedVersion) {
      throw new VersionConflictError();
    }

    const newVersion = expectedVersion + 1;
    const updated = await tx
      .update(markets)
      .set({
        ...patch,
        version: newVersion,
      })
      .where(eq(markets.id, id))
      .returning();

    if (adminAddress) {
      await tx.insert(marketAuditLog).values({
        marketId: id,
        adminAddress,
        action: "update",
        beforeState: {
          question: currentMarket.question,
          metadata: currentMarket.metadata,
          version: currentMarket.version,
        },
        afterState: {
          question: updated[0].question,
          metadata: updated[0].metadata,
          version: updated[0].version,
        },
      });
    }

    // Invalidate related cache entries
    await invalidateMarketCache(id);
    return updated[0];
  });

  // Structured log event – emitted from service layer after successful commit.
  emitMarketEvent(LogEvent.MARKET_UPDATED, {
    marketId: id,
    actor: adminAddress ?? "system",
    version: result.version,
    fieldsUpdated: Object.keys(patch),
  });

  return result;
}

/**
 * Creates a new off-chain market shell with canonical question, metadata, and resolution time.
 *
 * Markets are keyed by the on-chain ID supplied by the contract deployer.
 * On creation, the market is assigned indexedLedger=0 and archived=false.
 *
 * @param params.id - Market ID (unique, supplied by contract deployer)
 * @param params.question - Canonical market question (max 512 chars)
 * @param params.resolutionTime - Market resolution time (ISO 8601 string)
 * @param params.metadata - Optional market metadata (max 64KB serialized)
 * @param params.adminAddress - Stellar address of the admin creating the market
 * @returns Created market object with indexedLedger=0, archived=false, version=1
 * @throws MarketAlreadyExistsError if market with id already exists (409)
 * @throws Error if database query fails
 */
export async function createMarket(params: {
  id: string;
  question: string;
  resolutionTime: string;
  metadata?: Record<string, unknown>;
  adminAddress?: string;
}): Promise<any> {
  const { id, question, resolutionTime, metadata, adminAddress } = params;

  if (!id || typeof id !== "string") {
    throw new Error("Market ID must be a non-empty string");
  }

  if (!question || typeof question !== "string") {
    throw new Error("Question must be a non-empty string");
  }

  if (!resolutionTime || typeof resolutionTime !== "string") {
    throw new Error("Resolution time must be a non-empty ISO 8601 string");
  }

  const created = await db.transaction(async (tx) => {
    // Check if market already exists
    const existing = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);

    if (existing.length > 0) {
      throw new MarketAlreadyExistsError(id);
    }

    // Insert the new market
    const resolutionDate = new Date(resolutionTime);
    const result = await tx
      .insert(markets)
      .values({
        id,
        question,
        resolutionTime: resolutionDate,
        metadata: metadata || null,
        status: "upcoming",
        indexedLedger: 0,
        archived: false,
        version: 1,
      })
      .returning();

    if (!result[0]) {
      throw new Error("Failed to create market");
    }

    // Audit log if admin address is provided
    if (adminAddress) {
      await tx.insert(marketAuditLog).values({
        marketId: id,
        adminAddress,
        action: "create",
        beforeState: null,
        afterState: {
          id,
          question,
          resolutionTime: resolutionDate.toISOString(),
          metadata: metadata || null,
          status: "upcoming",
          indexedLedger: 0,
          archived: false,
          version: 1,
        },
      });
    }

    return result[0];
  });

  // Structured log event – emitted from service layer after successful commit.
  emitMarketEvent(LogEvent.MARKET_CREATED, {
    marketId: id,
    actor: adminAddress ?? "system",
    version: 1,
  });

  return created;
}
