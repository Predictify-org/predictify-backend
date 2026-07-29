/**
 * Idempotency-Key Cleanup Worker (#212)
 *
 * Purges expired rows from `idempotency_records`. Expired keys serve no
 * purpose (their stored responses can no longer be replayed) and left
 * unchecked the table grows unbounded, slowing the idempotency middleware's
 * hot-path lookups.
 *
 * Exposed three ways:
 *   - `cleanupIdempotencyKeys()` — run one pass, returns rows deleted.
 *   - `startIdempotencyCleanup()` — schedule it on a recurring interval.
 *   - `POST /api/internal/jobs/cleanup-idempotency-keys` — trigger on demand
 *     (see src/routes/internal/jobs.ts), e.g. from an external cron.
 */
import { lt } from "drizzle-orm";
import { db } from "../db";
import { idempotencyRecords } from "../db/schema";
import { logger } from "../config/logger";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Delete every idempotency record whose `expiresAt` is in the past. */
export async function cleanupIdempotencyKeys(now: Date = new Date()): Promise<number> {
  const result = await db
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, now));
  const deleted = (result as { rowCount?: number }).rowCount ?? 0;
  logger.info({ deleted }, "idempotency_cleanup");
  return deleted;
}

/**
 * Schedule the cleanup on a recurring interval. Returns the timer handle so the
 * caller can `clearInterval` it on shutdown. Failures are logged and never
 * crash the timer loop.
 */
export function startIdempotencyCleanup(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    cleanupIdempotencyKeys().catch((err) => {
      logger.error({ err }, "idempotency_cleanup_failed");
    });
  }, intervalMs);
}
