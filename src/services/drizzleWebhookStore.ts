/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, desc, eq, lt, or, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { webhookDeliveries as originalWebhookDeliveries, webhookDeliveriesDlq as originalWebhookDeliveriesDlq } from "../db/schema";
const webhookDeliveries = originalWebhookDeliveries as any;
const webhookDeliveriesDlq = originalWebhookDeliveriesDlq as any;

import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type Page,
} from "../utils/cursor";
import type {
  DlqRow,
  NewDelivery,
  WebhookDelivery,
  WebhookStore,
} from "./webhookStore";

/**
 * Production `WebhookStore` backed by drizzle/Postgres.
 *
 * The two correctness-critical operations — `moveToDlq` and the replay path —
 * run inside transactions so an exhausted delivery is dead-lettered exactly
 * once and never lives in both tables.
 */
export class DrizzleWebhookStore implements WebhookStore {
  constructor(private readonly db: Db) {}

  async createDelivery(input: NewDelivery): Promise<WebhookDelivery> {
    const [row] = (await this.db
      .insert(webhookDeliveries)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
        targetUrl: input.targetUrl,
        payload: input.payload,
        signature: input.signature,
        headers: input.headers ?? null,
        status: "pending",
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        nextAttemptAt: new Date(),
      })
      .returning()) as any;
    return row as WebhookDelivery;
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const [row] = (await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .limit(1)) as any;
    return (row as WebhookDelivery) ?? null;
  }

  async listDeliveries(cursor: unknown, limit: unknown): Promise<Page<WebhookDelivery>> {
    const take = clampLimit(limit);
    const key = decodeCursor(cursor);

    const where = key
      ? or(
          lt(webhookDeliveries.createdAt, new Date(key.sortValue)),
          and(
            eq(webhookDeliveries.createdAt, new Date(key.sortValue)),
            lt(webhookDeliveries.id, key.id),
          ),
        )
      : undefined;

    const rows = (await this.db
      .select()
      .from(webhookDeliveries)
      .where(where)
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(take + 1)) as WebhookDelivery[];

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    const last = data[data.length - 1];
    return {
      data,
      nextCursor:
        hasMore && last
          ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async updateDelivery(
    id: string,
    patch: Partial<
      Pick<WebhookDelivery, "status" | "attempts" | "lastError" | "nextAttemptAt">
    >,
  ): Promise<WebhookDelivery | null> {
    const [row] = (await this.db
      .update(webhookDeliveries)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, id))
      .returning()) as any;
    return (row as WebhookDelivery) ?? null;
  }

  async moveToDlq(deliveryId: string, lastError: string): Promise<DlqRow | null> {
    return this.db.transaction(async (tx) => {
      // Lock the live row; if it's gone, it was already dead-lettered.
      const [live] = (await tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
        .for("update")
        .limit(1)) as any;
      if (!live) return null;

      const [dlqRow] = (await tx
        .insert(webhookDeliveriesDlq)
        .values({
          originalId: live.id,
          eventId: live.eventId,
          eventType: live.eventType,
          targetUrl: live.targetUrl,
          payload: live.payload,
          signature: live.signature,
          headers: live.headers ?? null,
          attempts: live.attempts,
          maxAttempts: live.maxAttempts,
          lastError,
        })
        .returning()) as any;

      await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
      return dlqRow as DlqRow;
    });
  }

  async getDlqRow(id: string): Promise<DlqRow | null> {
    const [row] = (await this.db
      .select()
      .from(webhookDeliveriesDlq)
      .where(eq(webhookDeliveriesDlq.id, id))
      .limit(1)) as any;
    return (row as DlqRow) ?? null;
  }

  async listDlq(cursor: unknown, limit: unknown): Promise<Page<DlqRow>> {
    const take = clampLimit(limit);
    const key = decodeCursor(cursor);

    // Keyset predicate for DESC (failed_at, id): rows strictly "after" the
    // cursor are older, or same timestamp with a smaller id.
    const where = key
      ? or(
          lt(webhookDeliveriesDlq.failedAt, new Date(key.sortValue)),
          and(
            eq(webhookDeliveriesDlq.failedAt, new Date(key.sortValue)),
            lt(webhookDeliveriesDlq.id, key.id),
          ),
        )
      : undefined;

    const rows = (await this.db
      .select()
      .from(webhookDeliveriesDlq)
      .where(where)
      .orderBy(desc(webhookDeliveriesDlq.failedAt), desc(webhookDeliveriesDlq.id))
      .limit(take + 1)) as DlqRow[]; // fetch one extra to detect "has more"

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    const last = data[data.length - 1];
    return {
      data,
      nextCursor:
        hasMore && last
          ? encodeCursor({ sortValue: last.failedAt.toISOString(), id: last.id })
          : null,
    };
  }

  async markReplayed(dlqId: string, replayDeliveryId: string): Promise<boolean> {
    // Conditional update: only flips rows not yet replayed → idempotent.
    const updated = await this.db
      .update(webhookDeliveriesDlq)
      .set({ replayedAt: new Date(), replayDeliveryId })
      .where(
        and(eq(webhookDeliveriesDlq.id, dlqId), isNull(webhookDeliveriesDlq.replayedAt)),
      )
      .returning({ id: webhookDeliveriesDlq.id });
    return updated.length > 0;
  }
}
