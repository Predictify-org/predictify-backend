/**
 * predictionRepo.ts
 *
 * Data-access layer for the authenticated user's predictions.
 *
 * Design notes
 * ------------
 * - Keyset (cursor) pagination on `(createdAt DESC, id DESC)` is preferred
 *   over OFFSET/LIMIT because the result set stays stable and fast even as new
 *   predictions are written between page loads.
 * - The cursor encodes `{ sortValue: createdAt ISO-string, id: UUID }` via the
 *   shared `encodeCursor` / `decodeCursor` helpers in `src/utils/cursor.ts`.
 *   Cursors are versioned; a stale or tampered cursor token is silently treated
 *   as absent (restart from page 1) rather than 500-ing.
 * - Optional filters (marketId, status, outcome) are injected as additional
 *   `WHERE` conditions using parameterised Drizzle column expressions — no
 *   string interpolation, so injection is structurally impossible.
 * - One extra row is fetched (`limit + 1`) to determine whether a subsequent
 *   page exists without a separate COUNT query.
 */

import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db/client";
import { markets, predictions } from "../db/schema";
import { decodeCursor, encodeCursor, type Page } from "../utils/cursor";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A single prediction row as returned to the API layer.
 * Dates are serialised to ISO-8601 strings for a stable JSON wire format.
 */
export interface PredictionRow {
  id: string;
  marketId: string;
  /** Human-readable question text from the joined markets row. */
  question: string;
  outcome: string;
  amount: string;
  txHash: string;
  status: string;
  result: string | null;
  createdAt: string;
  resolutionTime: string;
}

/**
 * Filter options accepted by `listPredictions`.
 */
export interface ListPredictionsFilter {
  /** Scope results to a single market. */
  marketId?: string;
  /** Filter by prediction lifecycle status (pending, confirmed, won, lost, claimed). */
  status?: string;
  /** Filter by the chosen outcome value (e.g. "yes" / "no"). */
  outcome?: string;
}

/**
 * Pagination options accepted by `listPredictions`.
 */
export interface ListPredictionsOptions extends ListPredictionsFilter {
  /** Number of rows to return per page (already clamped by the caller). */
  limit: number;
  /** Opaque cursor token from the previous page's `nextCursor`. */
  cursor?: string;
}

// ── Repository function ───────────────────────────────────────────────────────

/**
 * Fetch one page of predictions for `userId` using keyset pagination.
 *
 * Sort order: `(createdAt DESC, id DESC)` — stable even when multiple
 * predictions share the same timestamp because the UUID tie-breaker is unique.
 *
 * Keyset WHERE predicate for DESC ordering:
 *   `(createdAt < cursorTime)
 *    OR (createdAt = cursorTime AND id < cursorId)`
 *
 * @param userId  - UUID of the authenticated user (scopes the query).
 * @param options - Pagination + filter options.
 * @returns       - `{ data, nextCursor }` — `nextCursor` is null on the last page.
 */
export async function listPredictions(
  userId: string,
  options: ListPredictionsOptions,
): Promise<Page<PredictionRow>> {
  const { limit, cursor, marketId, status, outcome } = options;

  // ------------------------------------------------------------------
  // Build WHERE conditions.  All conditions use parameterised Drizzle
  // column expressions — never string-interpolated values.
  // ------------------------------------------------------------------

  // Always scope to the authenticated user.
  const conditions = [eq(predictions.userId, userId)];

  if (marketId) {
    conditions.push(eq(predictions.marketId, marketId));
  }

  if (status) {
    conditions.push(eq(predictions.status, status));
  }

  if (outcome) {
    conditions.push(eq(predictions.outcome, outcome));
  }

  // Decode the opaque cursor.  An invalid / version-mismatched token returns
  // null, which is safe — we just start from the beginning of the ordered set.
  const cursorKey = decodeCursor(cursor);

  if (cursorKey) {
    const cursorTime = new Date(cursorKey.sortValue);
    // Standard two-column keyset predicate for DESC (createdAt, id):
    //   rows that are strictly "earlier" in the sort order than the last
    //   row on the previous page.
    conditions.push(
      or(
        lt(predictions.createdAt, cursorTime),
        and(
          eq(predictions.createdAt, cursorTime),
          lt(predictions.id, cursorKey.id),
        ),
      )!,
    );
  }

  // ------------------------------------------------------------------
  // Execute the paginated query.  Fetch limit+1 rows so we can detect
  // whether another page follows without a separate COUNT(*) round-trip.
  // ------------------------------------------------------------------
  const rows = await db
    .select({
      id: predictions.id,
      marketId: predictions.marketId,
      question: markets.question,
      outcome: predictions.outcome,
      amount: predictions.amount,
      txHash: predictions.txHash,
      status: predictions.status,
      result: predictions.result,
      createdAt: predictions.createdAt,
      resolutionTime: markets.resolutionTime,
    })
    .from(predictions)
    .innerJoin(markets, eq(predictions.marketId, markets.id))
    .where(and(...conditions))
    .orderBy(desc(predictions.createdAt), desc(predictions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  // Mint the next-page cursor from the last row on this page.  The shared
  // `encodeCursor` helper stamps the current CURSOR_VERSION into the token so
  // old cursors are rejected after a schema migration rather than silently
  // mis-paginating.
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sortValue: last.createdAt.toISOString(),
          id: last.id,
        })
      : null;

  return {
    data: data.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      resolutionTime: r.resolutionTime.toISOString(),
    })),
    nextCursor,
  };
}
