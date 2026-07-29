import { and, desc, eq, lt, or } from "drizzle-orm";

import { db } from "../db";
import { marketComments } from "../db/schema";
import { clampLimit, decodeCursor, encodeCursor, type CursorKey } from "../utils/cursor";

export interface MarketComment {
    id: string;
    marketId: string;
    authorId: string | null;
    authorAddress: string | null;
    body: string;
    moderationFlagged: boolean;
    moderationReason: string | null;
    createdAt: Date;
}

const DEFAULT_LIMIT = 20;

export interface CommentsPage {
    data: MarketComment[];
    nextCursor: string | null;
}

function cursorKeyFromRow(row: Pick<MarketComment, "createdAt" | "id">): CursorKey {
    return {
        // createdAt must be lexicographically ordered; ISO is stable for UTC.
        sortValue: row.createdAt.toISOString(),
        id: row.id,
    };
}

/**
 * Cursor pagination for market comments.
 *
 * Ordering: DESC by (created_at, id).
 * Cursor represents the last row of the previous page.
 */
export async function listMarketComments(
    marketId: string,
    rawCursor: unknown,
    rawLimit: unknown,
): Promise<CommentsPage> {
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT);

    const cursor = decodeCursor(rawCursor);

    const where = cursor
        ? and(
            eq(marketComments.marketId, marketId),
            // Under DESC ordering, we want rows strictly "before" the cursor key.
            or(
                lt(marketComments.createdAt, new Date(cursor.sortValue)),
                and(
                    eq(marketComments.createdAt, new Date(cursor.sortValue)),
                    lt(marketComments.id, cursor.id),
                ),
            ),
        )
        : eq(marketComments.marketId, marketId);

    const rows = await db
        .select()
        .from(marketComments)
        .where(where)
        .orderBy(desc(marketComments.createdAt), desc(marketComments.id))
        .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
        data: pageRows as unknown as MarketComment[],
        nextCursor: hasMore && last ? encodeCursor(cursorKeyFromRow(last)) : null,
    };
}

