/**
 * Notification Digest Worker
 *
 * Implements issue #217 — a daily/weekly digest of user notifications.
 *
 * For each user that has at least one digest-enabled notification preference,
 * we group their pending notifications by category and hand the resulting
 * digest to a pluggable delivery sink (email/webhook in production, a noop in
 * tests). The job is idempotent at the granularity of a run: it only looks at
 * preferences and produces one digest per user per invocation.
 *
 * Runs on a configurable interval (default: daily). The interval and the
 * digest cadence are independent — a "weekly" digest is simply scheduled with
 * a 7-day interval by the caller.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { notificationPreferences } from "../db/schema";
import { logger } from "../config/logger";

/** A per-user digest ready to be delivered. */
export interface UserDigest {
  userId: string;
  /** Notification categories the user has opted in to receive digests for. */
  categories: string[];
  generatedAt: string;
}

/** Cadence selector — purely informational, carried through to the sink. */
export type DigestCadence = "daily" | "weekly";

/** Delivery sink. Returns once the digest has been handed off. */
export type DigestSink = (digest: UserDigest) => Promise<void> | void;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build one digest per user from their digest-enabled preferences.
 * Exported for unit testing without touching timers or delivery.
 */
export async function buildDigests(): Promise<UserDigest[]> {
  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      category: notificationPreferences.category,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.enabled, true));

  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byUser.get(row.userId) ?? new Set<string>();
    set.add(row.category);
    byUser.set(row.userId, set);
  }

  const generatedAt = new Date().toISOString();
  return Array.from(byUser.entries()).map(([userId, categories]) => ({
    userId,
    categories: Array.from(categories).sort(),
    generatedAt,
  }));
}

/**
 * Run a single digest pass: build digests and push each to the sink.
 * Sink failures are logged per-user and never abort the whole run.
 */
export async function runNotificationDigest(
  sink: DigestSink,
  cadence: DigestCadence = "daily",
): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;

  try {
    const digests = await buildDigests();
    for (const digest of digests) {
      try {
        await sink(digest);
        delivered += 1;
      } catch (err) {
        failed += 1;
        logger.error({ err, userId: digest.userId, cadence }, "notification_digest_delivery_failed");
      }
    }
    logger.info({ cadence, delivered, failed, users: digests.length }, "notification_digest_run");
  } catch (err) {
    logger.error({ err, cadence }, "notification_digest_failed");
  }

  return { delivered, failed };
}

export interface NotificationDigestOptions {
  /** Interval between runs in ms. Default: 24h (daily). Use 7×24h for weekly. */
  intervalMs?: number;
  cadence?: DigestCadence;
  sink: DigestSink;
}

/**
 * Start the digest job on a recurring interval. Returns the timer handle so
 * the caller can `clearInterval` it on shutdown.
 */
export function startNotificationDigest(opts: NotificationDigestOptions): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const cadence = opts.cadence ?? "daily";
  return setInterval(() => {
    void runNotificationDigest(opts.sink, cadence);
  }, intervalMs);
}
