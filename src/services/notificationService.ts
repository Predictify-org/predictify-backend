import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { notifications } from "../db/schema";

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