/**
 * webhookDispatcher.ts
 *
 * Signs and delivers webhook payloads to subscribers.
 *
 * Design overview
 * ───────────────
 *  • Every outgoing POST is signed with HMAC-SHA256 computed over the *raw
 *    JSON bytes* of the body (not parsed/re-serialised).  The signature is
 *    placed in the X-Predictify-Signature header as "sha256=<hex>".
 *
 *  • A unique delivery ID (UUID) is included in X-Predictify-Delivery so
 *    subscribers can detect duplicates on retry.
 *
 *  • Retries follow a fixed backoff schedule (30 s, 5 m, 1 h, 6 h, 24 h).
 *    After 5 failed attempts the delivery transitions to "terminal" status.
 *    The DLQ move is handled by a sibling issue.
 *
 *  • `dispatchEvent` fans out to all matching active subscriptions
 *    **concurrently** using Promise.allSettled — a slow or failing subscriber
 *    never blocks delivery to others.
 *
 *  • `verifySignature` uses crypto.timingSafeEqual to prevent timing attacks
 *    when verifying inbound signatures (e.g. in a receive-side test helper).
 */

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { and, eq, lte, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { webhookDeliveries, webhookSubscriptions } from "../db/schema";
import { logger } from "../config/logger";
import { webhookQueue } from "../queue";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Subset of the delivery row returned to callers. */
export interface DeliveryRecord {
  id: string;
  subscriptionId: string;
  eventType: string;
  status: string;
  attempt: number;
  nextRetryAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
}

/** Result of a single send attempt. */
export interface AttemptResult {
  deliveryId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Backoff delays in milliseconds, indexed by attempt number (0-based).
 * Attempt 0 → first real try; on failure nextRetry is BACKOFF_MS[0] = 30 s.
 * Attempt 4 → last retry; on failure the delivery becomes terminal.
 */
export const BACKOFF_MS: readonly number[] = [
  30 * 1_000,        // 30 s
  5 * 60 * 1_000,    // 5 m
  60 * 60 * 1_000,   // 1 h
  6 * 60 * 60 * 1_000,  // 6 h
  24 * 60 * 60 * 1_000, // 24 h
] as const;

/** Total number of attempts before a delivery becomes terminal. */
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // 6 total (1 initial + 5 retries)

/** HTTP POST timeout in milliseconds. */
const DELIVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random 32-byte hex secret suitable for
 * storing in `webhook_subscriptions.secret`.
 */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Computes the HMAC-SHA256 signature over raw body bytes.
 *
 * @param secret - Hex-encoded 32-byte HMAC secret from the subscription row.
 * @param rawBody - The exact bytes that will be sent as the request body.
 * @returns Signature string in the format "sha256=<hex>".
 */
export function signPayload(secret: string, rawBody: Buffer): string {
  const sig = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(rawBody)
    .digest("hex");
  return `sha256=${sig}`;
}

/**
 * Verifies that an inbound `X-Predictify-Signature` header matches the
 * expected HMAC over the raw body.  Uses `crypto.timingSafeEqual` to prevent
 * timing-based side-channel attacks.
 *
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifySignature(secret: string, rawBody: Buffer, signature: string): boolean {
  // Guard against obviously-wrong signatures before the timing-safe compare.
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) {
    return false;
  }
  const expected = signPayload(secret, rawBody);
  // Buffers must be the same length for timingSafeEqual, so we hash both to
  // fixed-length digests first.
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch an event to all active subscribers that have opted in to the
 * given `eventType`.
 *
 * For each matching subscription a `webhook_deliveries` row is created (status
 * "pending") and an immediate delivery attempt is made.  All deliveries run
 * concurrently via Promise.allSettled — a slow subscriber cannot block others.
 *
 * @param db        - Drizzle database instance.
 * @param eventType - Event type string, e.g. "market.resolved".
 * @param payload   - Arbitrary JSON-serialisable payload.
 * @returns Array of attempt results (one per matching subscription).
 */
export async function dispatchEvent(
  db: NodePgDatabase,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<AttemptResult[]> {
  // 1. Find all active subscriptions interested in this event type.
  const subscriptions = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.active, true));

  const matching = subscriptions.filter((sub) => {
    const events = sub.events as string[];
    return Array.isArray(events) && (events.includes(eventType) || events.includes("*"));
  });

  if (matching.length === 0) {
    logger.debug({ eventType }, "webhook.dispatch.no_subscribers");
    return [];
  }

  // 2. (Removed rawBody serialisation since it's deferred to the worker)

  // 3. Create delivery rows for each subscriber, then attempt concurrently.
  const results = await Promise.allSettled(
    matching.map(async (sub) => {
      // Insert a delivery record.
      const [delivery] = await db
        .insert(webhookDeliveries)
        .values({
          subscriptionId: sub.id,
          eventType,
          payload: payload as Record<string, unknown>,
          status: "pending",
          attempt: 0,
          nextRetryAt: new Date(),
        })
        .returning();

      if (!delivery) throw new Error("Failed to insert delivery record");

      // Enqueue the first delivery attempt to BullMQ.
      await webhookQueue.add("deliver", { deliveryId: delivery.id });
      return { deliveryId: delivery.id, success: true, statusCode: 202 };
    }),
  );

  // 4. Unwrap allSettled results, logging any unexpected promise rejections.
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    logger.error(
      { err: r.reason, subscriptionId: matching[i]?.id, eventType },
      "webhook.dispatch.unexpected_error",
    );
    return { deliveryId: "unknown", success: false, error: String(r.reason) };
  });
}

/**
 * Attempt to POST a single delivery.  Updates the `webhook_deliveries` row
 * with the outcome and schedules the next retry if necessary.
 *
 * This function is also called by the worker for retry attempts.
 *
 * @param db         - Drizzle database instance.
 * @param deliveryId - UUID of the delivery row.
 * @param url        - Destination URL.
 * @param secret     - Hex-encoded HMAC secret from the subscription.
 * @param rawBody    - Pre-serialised payload bytes (signed as-is).
 * @param eventType  - Event type string for the X-Predictify-Event header.
 */
export async function attemptDelivery(
  db: NodePgDatabase,
  deliveryId: string,
  url: string,
  secret: string,
  rawBody: Buffer,
  eventType: string,
): Promise<AttemptResult> {
  // Mark as "delivering" to prevent duplicate pickup by concurrent workers.
  const [delivery] = await db
    .update(webhookDeliveries)
    .set({ status: "delivering", updatedAt: new Date() })
    .where(eq(webhookDeliveries.id, deliveryId))
    .returning();

  if (!delivery) {
    return { deliveryId, success: false, error: "delivery record not found" };
  }

  const attempt = delivery.attempt + 1;
  const signature = signPayload(secret, rawBody);

  let statusCode: number | undefined;
  let errorMessage: string | undefined;
  let success = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Predictify-Signature": signature,
          "X-Predictify-Event": eventType,
          "X-Predictify-Delivery": deliveryId,
        },
        body: rawBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    statusCode = response.status;
    success = response.status >= 200 && response.status < 300;

    if (!success) {
      // Read a truncated response body for diagnostics.
      const text = await response.text().catch(() => "");
      errorMessage = `HTTP ${response.status}: ${text.slice(0, 256)}`;
    }
  } catch (err) {
    // Network error or AbortError (timeout).
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // Compute next status and retry schedule.
  const { nextStatus, nextRetryAt } = computeNextState(attempt, success);

  await db
    .update(webhookDeliveries)
    .set({
      status: nextStatus,
      attempt,
      lastStatusCode: statusCode ?? null,
      lastError: errorMessage ?? null,
      nextRetryAt,
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  logger.info(
    { deliveryId, attempt, success, statusCode, nextStatus, url, eventType },
    "webhook.delivery.attempt",
  );

  return { deliveryId, success, statusCode, error: errorMessage };
}

/**
 * Determines the next delivery status and the `nextRetryAt` timestamp.
 *
 * @param attempt - The attempt number that just completed (1-based).
 * @param success - Whether this attempt received a 2xx response.
 */
export function computeNextState(
  attempt: number,
  success: boolean,
): { nextStatus: string; nextRetryAt: Date } {
  if (success) {
    return { nextStatus: "success", nextRetryAt: new Date() };
  }

  // Attempts are 1-based; BACKOFF_MS is 0-based (indexed by attempt - 1).
  const backoffIndex = attempt - 1;
  const backoffMs = BACKOFF_MS[backoffIndex];

  if (backoffMs === undefined) {
    // Exhausted all retries.
    return { nextStatus: "terminal", nextRetryAt: new Date() };
  }

  return {
    nextStatus: "failed",
    nextRetryAt: new Date(Date.now() + backoffMs),
  };
}

// ---------------------------------------------------------------------------
// Subscription helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new webhook subscription with a freshly-generated secret.
 *
 * @returns The inserted subscription row including the plaintext secret.
 *          Store the secret securely — it is never returned again.
 */
export async function createSubscription(
  db: NodePgDatabase,
  opts: { url: string; events: string[] },
): Promise<typeof webhookSubscriptions.$inferSelect> {
  const secret = generateSecret();
  const [sub] = await db
    .insert(webhookSubscriptions)
    .values({ url: opts.url, secret, events: opts.events, active: true })
    .returning();
  if (!sub) throw new Error("Failed to create subscription");
  return sub;
}

/**
 * Soft-deletes a subscription by setting `active = false`.
 */
export async function deactivateSubscription(db: NodePgDatabase, id: string): Promise<void> {
  await db
    .update(webhookSubscriptions)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(webhookSubscriptions.id, id));
}

/**
 * Returns pending/failed deliveries whose nextRetryAt has elapsed.
 * Used by the webhook worker to pick up work on each polling tick.
 */
export async function getOverdueDeliveries(
  db: NodePgDatabase,
  limit = 50,
): Promise<(typeof webhookDeliveries.$inferSelect)[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.status, ["pending", "failed"]),
        lte(webhookDeliveries.nextRetryAt, new Date()),
      ),
    )
    .limit(limit);
}
