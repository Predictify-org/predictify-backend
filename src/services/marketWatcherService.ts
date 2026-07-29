/**
 * marketWatcherService.ts
 *
 * Service for listing, adding, and removing watchers (subscribers) of a market.
 */

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { markets, marketWatchers, users } from "../db/schema";
import { NotFoundError } from "../errors";
import { clampLimit, decodeCursor, encodeCursor, type Page } from "../utils/cursor";

export interface MarketWatcherRow {
  id: string;
  marketId: string;
  userId: string;
  stellarAddress: string | null;
  createdAt: string;
}

export interface ListMarketWatchersOptions {
  limit?: number;
  cursor?: string;
}

/**
 * Ensures that a market exists, throwing NotFoundError if it does not.
 */
export async function assertMarketExists(marketId: string): Promise<void> {
  const [existing] = await getDb()
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);

  if (!existing) {
    throw new NotFoundError(`Market with ID ${marketId} not found`);
  }
}

/**
 * Lists subscribers/watchers of a market with keyset pagination.
 *
 * Sort order: (createdAt DESC, id DESC)
 */
export async function listMarketWatchers(
  marketId: string,
  options: ListMarketWatchersOptions = {},
): Promise<Page<MarketWatcherRow> & { total: number }> {
  await assertMarketExists(marketId);

  const take = clampLimit(options.limit);
  const cursorKey = decodeCursor(options.cursor);

  const conditions = [eq(marketWatchers.marketId, marketId)];

  if (cursorKey) {
    const cursorTime = new Date(cursorKey.sortValue);
    conditions.push(
      or(
        lt(marketWatchers.createdAt, cursorTime),
        and(
          eq(marketWatchers.createdAt, cursorTime),
          lt(marketWatchers.id, cursorKey.id),
        ),
      )!,
    );
  }

  const rows = await getDb()
    .select({
      id: marketWatchers.id,
      marketId: marketWatchers.marketId,
      userId: marketWatchers.userId,
      stellarAddress: users.stellarAddress,
      createdAt: marketWatchers.createdAt,
    })
    .from(marketWatchers)
    .leftJoin(users, eq(marketWatchers.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(marketWatchers.createdAt), desc(marketWatchers.id))
    .limit(take + 1);

  const [countResult] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(marketWatchers)
    .where(eq(marketWatchers.marketId, marketId));

  const total = countResult?.count ?? 0;
  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;
  const last = data[data.length - 1];

  const formattedData: MarketWatcherRow[] = data.map((r) => ({
    id: r.id,
    marketId: r.marketId,
    userId: r.userId,
    stellarAddress: r.stellarAddress,
    createdAt: r.createdAt.toISOString(),
  }));

  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sortValue: last.createdAt.toISOString(),
          id: last.id,
        })
      : null;

  return {
    data: formattedData,
    nextCursor,
    total,
  };
}

/**
 * Adds a user as a watcher of a market.
 */
export async function addMarketWatcher(
  marketId: string,
  userId: string,
): Promise<MarketWatcherRow> {
  await assertMarketExists(marketId);

  // Check if watcher already exists
  const [existing] = await getDb()
    .select({
      id: marketWatchers.id,
      marketId: marketWatchers.marketId,
      userId: marketWatchers.userId,
      stellarAddress: users.stellarAddress,
      createdAt: marketWatchers.createdAt,
    })
    .from(marketWatchers)
    .leftJoin(users, eq(marketWatchers.userId, users.id))
    .where(
      and(
        eq(marketWatchers.marketId, marketId),
        eq(marketWatchers.userId, userId),
      ),
    )
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      marketId: existing.marketId,
      userId: existing.userId,
      stellarAddress: existing.stellarAddress,
      createdAt: existing.createdAt.toISOString(),
    };
  }

  const [inserted] = await getDb()
    .insert(marketWatchers)
    .values({
      marketId,
      userId,
    })
    .returning();

  const [userRow] = await getDb()
    .select({ stellarAddress: users.stellarAddress })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    id: inserted.id,
    marketId: inserted.marketId,
    userId: inserted.userId,
    stellarAddress: userRow?.stellarAddress ?? null,
    createdAt: inserted.createdAt.toISOString(),
  };
}

/**
 * Removes a user as a watcher of a market.
 */
export async function removeMarketWatcher(
  marketId: string,
  userId: string,
): Promise<boolean> {
  await assertMarketExists(marketId);

  const deleted = await getDb()
    .delete(marketWatchers)
    .where(
      and(
        eq(marketWatchers.marketId, marketId),
        eq(marketWatchers.userId, userId),
      ),
    )
    .returning({ id: marketWatchers.id });

  return deleted.length > 0;
}
