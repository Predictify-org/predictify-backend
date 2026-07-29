import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/client";
import { notifications, type Notification } from "../db/schema";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type CursorKey,
  type Page,
} from "../utils/cursor";

export interface MarkNotificationsAsReadParams {
  userId: string;
  notificationIds?: string[];
  markAllAsRead?: boolean;
}

export interface MarkNotificationsAsReadResult {
  updatedCount: number;
}

export async function markNotificationsAsRead(
  params: MarkNotificationsAsReadParams,
): Promise<MarkNotificationsAsReadResult> {
  const { userId, notificationIds, markAllAsRead } = params;

  let updatedCount = 0;

  if (markAllAsRead) {
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    updatedCount = result.rowCount ?? 0;
  } else if (notificationIds && notificationIds.length > 0) {
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          inArray(notifications.id, notificationIds),
        ),
      );
    updatedCount = result.rowCount ?? 0;
  }

  return { updatedCount };
}

// ---------------------------------------------------------------------------
// List notifications with cursor pagination
// ---------------------------------------------------------------------------

/**
 * Shape of a single notification item returned to callers.
 * Keeps the service boundary explicit — consumers don't depend on the raw
 * Drizzle row type.
 */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export interface ListNotificationsParams {
  userId: string;
  /** Opaque cursor returned by a previous call (base64url-encoded). */
  cursor?: string;
  /** Page size; clamped to [1, 100], defaults to 20. */
  limit?: number;
}

/**
 * Build the cursor key for the last row of a page.
 * Sort column is `created_at` (ISO-8601 string), tie-broken by `id`.
 */
function rowToCursorKey(row: Pick<Notification, "createdAt" | "id">): CursorKey {
  return {
    sortValue: row.createdAt.toISOString(),
    id: row.id,
  };
}

/**
 * Cursor-paginated list of notifications for a single user.
 *
 * Ordering: `(created_at DESC, id DESC)` — stable under concurrent inserts
 * because the composite key is unique.
 *
 * A cursor encodes the last row of the previous page.  Pass it back as
 * `?cursor=` to advance.  An invalid or tampered cursor is silently treated
 * as absent (restarts from page one) so no 400 is returned for stale tokens.
 */
export async function listNotifications(
  params: ListNotificationsParams,
): Promise<Page<NotificationItem>> {
  const { userId, cursor: rawCursor, limit: rawLimit } = params;

  const limit = clampLimit(rawLimit);
  const cursor = decodeCursor(rawCursor);

  // Build the keyset predicate.
  // Under DESC ordering, "after cursor" means:
  //   created_at < cursor.sortValue  OR  (created_at = cursor.sortValue AND id < cursor.id)
  const where = cursor
    ? and(
        eq(notifications.userId, userId),
        or(
          lt(notifications.createdAt, new Date(cursor.sortValue)),
          and(
            eq(notifications.createdAt, new Date(cursor.sortValue)),
            lt(notifications.id, cursor.id),
          ),
        ),
      )
    : eq(notifications.userId, userId);

  // Fetch one extra row to detect whether a next page exists.
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      data: notifications.data,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    data: pageRows as NotificationItem[],
    nextCursor: hasMore && last ? encodeCursor(rowToCursorKey(last)) : null,
  };
}