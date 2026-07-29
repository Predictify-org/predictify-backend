import { randomUUID } from "node:crypto";
import {
  type CursorKey,
  type Page,
  paginate,
} from "../utils/cursor";

/**
 * Persistence boundary for webhook deliveries and the dead-letter queue.
 *
 * Both the dispatcher and the admin routes depend on this interface rather than
 * on drizzle directly. That keeps the HTTP/queue logic database-agnostic and —
 * importantly for this PR — lets the end-to-end tests run against a fast
 * in-memory implementation with no Postgres required, while production wires in
 * `DrizzleWebhookStore` (see drizzleWebhookStore.ts).
 */

export type DeliveryStatus = "pending" | "delivered" | "failed";

/** A row in the live `webhook_deliveries` queue. */
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  targetUrl: string;
  /** Original signed body bytes — preserved verbatim for faithful replay. */
  payload: Buffer;
  /** Signature header value computed over `payload`. */
  signature: string;
  headers: Record<string, string> | null;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A row in the `webhook_deliveries_dlq` table. */
export interface DlqRow {
  id: string;
  originalId: string;
  eventId: string;
  eventType: string;
  targetUrl: string;
  payload: Buffer;
  signature: string;
  headers: Record<string, string> | null;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  failedAt: Date;
  replayedAt: Date | null;
  replayDeliveryId: string | null;
}

/** Fields needed to create a brand-new live delivery. */
export interface NewDelivery {
  eventId: string;
  eventType: string;
  targetUrl: string;
  payload: Buffer;
  signature: string;
  headers?: Record<string, string> | null;
  maxAttempts?: number;
}

export interface WebhookStore {
  /** Insert a fresh live delivery (attempts = 0). */
  createDelivery(input: NewDelivery): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | null>;
  /** List live deliveries newest first using keyset pagination over (createdAt, id). */
  listDeliveries(cursor: unknown, limit: unknown): Promise<Page<WebhookDelivery>>;
  /** Persist mutated delivery fields (status/attempts/error/nextAttemptAt). */
  updateDelivery(
    id: string,
    patch: Partial<
      Pick<WebhookDelivery, "status" | "attempts" | "lastError" | "nextAttemptAt">
    >,
  ): Promise<WebhookDelivery | null>;

  /**
   * Atomically move an exhausted live delivery into the DLQ: insert the DLQ row
   * and remove the live row in a single transaction so a delivery can never be
   * dead-lettered twice or left in both tables. Returns the created DLQ row, or
   * null if the live delivery no longer exists (already dead-lettered).
   */
  moveToDlq(deliveryId: string, lastError: string): Promise<DlqRow | null>;

  getDlqRow(id: string): Promise<DlqRow | null>;
  listDlq(cursor: unknown, limit: unknown): Promise<Page<DlqRow>>;

  /**
   * Mark a DLQ row replayed and record which fresh delivery it produced.
   * Returns false if the row was already replayed (idempotency guard).
   */
  markReplayed(dlqId: string, replayDeliveryId: string): Promise<boolean>;
}

const dlqKey = (r: DlqRow): CursorKey => ({
  sortValue: r.failedAt.toISOString(),
  id: r.id,
});

const deliveryKey = (r: WebhookDelivery): CursorKey => ({
  sortValue: r.createdAt.toISOString(),
  id: r.id,
});

/**
 * In-memory store for tests and local development. Not for production use:
 * state is lost on restart and `moveToDlq`/`markReplayed` are only "atomic" in
 * the single-threaded JS sense.
 */
export class InMemoryWebhookStore implements WebhookStore {
  private deliveries = new Map<string, WebhookDelivery>();
  private dlq = new Map<string, DlqRow>();

  async createDelivery(input: NewDelivery): Promise<WebhookDelivery> {
    const now = new Date();
    const row: WebhookDelivery = {
      id: randomUUID(),
      eventId: input.eventId,
      eventType: input.eventType,
      targetUrl: input.targetUrl,
      payload: input.payload,
      signature: input.signature,
      headers: input.headers ?? null,
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      lastError: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveries.set(row.id, row);
    return { ...row };
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const row = this.deliveries.get(id);
    return row ? { ...row } : null;
  }

  async listDeliveries(cursor: unknown, limit: unknown): Promise<Page<WebhookDelivery>> {
    const sorted = [...this.deliveries.values()].sort((a, b) => {
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      return t !== 0 ? t : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    });
    const page = paginate(sorted, deliveryKey, cursor, limit);
    return { data: page.data.map((r) => ({ ...r })), nextCursor: page.nextCursor };
  }

  async updateDelivery(
    id: string,
    patch: Partial<
      Pick<WebhookDelivery, "status" | "attempts" | "lastError" | "nextAttemptAt">
    >,
  ): Promise<WebhookDelivery | null> {
    const row = this.deliveries.get(id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date() });
    return { ...row };
  }

  async moveToDlq(deliveryId: string, lastError: string): Promise<DlqRow | null> {
    const live = this.deliveries.get(deliveryId);
    if (!live) return null; // already dead-lettered → exactly-once
    const dlqRow: DlqRow = {
      id: randomUUID(),
      originalId: live.id,
      eventId: live.eventId,
      eventType: live.eventType,
      targetUrl: live.targetUrl,
      payload: live.payload,
      signature: live.signature,
      headers: live.headers,
      attempts: live.attempts,
      maxAttempts: live.maxAttempts,
      lastError,
      failedAt: new Date(),
      replayedAt: null,
      replayDeliveryId: null,
    };
    this.dlq.set(dlqRow.id, dlqRow);
    this.deliveries.delete(deliveryId); // remove from live in the same step
    return { ...dlqRow };
  }

  async getDlqRow(id: string): Promise<DlqRow | null> {
    const row = this.dlq.get(id);
    return row ? { ...row } : null;
  }

  async listDlq(cursor: unknown, limit: unknown): Promise<Page<DlqRow>> {
    const sorted = [...this.dlq.values()].sort((a, b) => {
      const t = b.failedAt.getTime() - a.failedAt.getTime();
      return t !== 0 ? t : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    });
    const page = paginate(sorted, dlqKey, cursor, limit);
    return { data: page.data.map((r) => ({ ...r })), nextCursor: page.nextCursor };
  }

  async markReplayed(dlqId: string, replayDeliveryId: string): Promise<boolean> {
    const row = this.dlq.get(dlqId);
    if (!row || row.replayedAt) return false;
    row.replayedAt = new Date();
    row.replayDeliveryId = replayDeliveryId;
    return true;
  }
}
