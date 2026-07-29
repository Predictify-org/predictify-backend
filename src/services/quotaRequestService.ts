import { db } from "../db/client";
import { quotaRequests } from "../db/schema";
import { eq, desc, and, count } from "drizzle-orm";
import { Result, ok, err, RouteErrorFactory } from "../errors/RouteError";
import { getRequestId } from "../lib/requestContext";
import { logger } from "../config/logger";

// ── Quota types ─────────────────────────────────────────────────────────────

export const VALID_QUOTA_TYPES = [
  "prediction_limit",
  "daily_prediction_limit",
  "claim_limit",
] as const;

export type QuotaType = (typeof VALID_QUOTA_TYPES)[number];

// ── Input / output types ─────────────────────────────────────────────────────

export interface CreateQuotaRequestInput {
  userId: string;
  quotaType: string;
  requestedValue: number;
  reason: string;
}

/**
 * Serialised shape of a quota-request row returned to callers.
 * Timestamps are ISO-8601 strings; null review fields indicate
 * the request has not yet been reviewed by an admin.
 */
export interface QuotaRequestRow {
  id: string;
  userId: string;
  quotaType: string;
  requestedValue: number;
  reason: string;
  status: string;
  reviewedBy: string | null;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Maps a raw DB row to the public QuotaRequestRow shape. */
function toRow(row: typeof quotaRequests.$inferSelect): QuotaRequestRow {
  return {
    id: row.id,
    userId: row.userId,
    quotaType: row.quotaType,
    requestedValue: row.requestedValue,
    reason: row.reason,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewNotes: row.reviewNotes,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new quota request for the given user.
 *
 * All inputs are validated before touching the DB; on failure a
 * ValidationError is returned.  The reason is whitespace-trimmed.
 *
 * Returns the inserted row on success.
 */
export async function createQuotaRequest(
  input: CreateQuotaRequestInput,
): Promise<Result<QuotaRequestRow>> {
  const reqId = getRequestId();

  if (!VALID_QUOTA_TYPES.includes(input.quotaType as QuotaType)) {
    return err(
      RouteErrorFactory.validation(
        `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(", ")}`,
        { quotaType: [`Invalid value: "${input.quotaType}"`] },
      ),
    );
  }

  if (input.requestedValue < 1) {
    return err(
      RouteErrorFactory.validation("requestedValue must be a positive integer", {
        requestedValue: ["Must be at least 1"],
      }),
    );
  }

  if (input.reason.trim().length < 10) {
    return err(
      RouteErrorFactory.validation("reason must be at least 10 characters", {
        reason: ["Must be at least 10 characters"],
      }),
    );
  }

  if (input.reason.length > 1000) {
    return err(
      RouteErrorFactory.validation("reason must not exceed 1000 characters", {
        reason: ["Must not exceed 1000 characters"],
      }),
    );
  }

  try {
    const [inserted] = await db
      .insert(quotaRequests)
      .values({
        userId: input.userId,
        quotaType: input.quotaType,
        requestedValue: input.requestedValue,
        reason: input.reason.trim(),
      })
      .returning();

    logger.info(
      {
        reqId,
        quotaRequestId: inserted.id,
        userId: input.userId,
        quotaType: input.quotaType,
        requestedValue: input.requestedValue,
      },
      "quota_request_created",
    );

    return ok(toRow(inserted));
  } catch (e) {
    logger.error({ reqId, err: e, userId: input.userId }, "quota_request_create_failed");
    return err(RouteErrorFactory.internal("Failed to create quota request", e));
  }
}

/**
 * Fetch all quota requests for a user, ordered newest first.
 */
export async function getQuotaRequestsByUser(
  userId: string,
): Promise<Result<QuotaRequestRow[]>> {
  const reqId = getRequestId();

  try {
    const rows = await db
      .select()
      .from(quotaRequests)
      .where(eq(quotaRequests.userId, userId))
      .orderBy(desc(quotaRequests.createdAt));

    return ok(rows.map(toRow));
  } catch (e) {
    logger.error({ reqId, err: e, userId }, "quota_requests_list_failed");
    return err(RouteErrorFactory.internal("Failed to list quota requests", e));
  }
}

/**
 * Returns the number of pending (unreviewed) quota requests for a user.
 * Used by the route to enforce the per-user pending cap.
 */
export async function getPendingCountByUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(quotaRequests)
    .where(
      and(
        eq(quotaRequests.userId, userId),
        eq(quotaRequests.status, "pending"),
      ),
    );

  return Number(row?.value ?? 0);
}
