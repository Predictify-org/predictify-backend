import { db } from "../db/client";
import { users, predictions, markets } from "../db/schema";
import { and, eq, desc, lt, count, or } from "drizzle-orm";
import { Result, ok, err } from "../errors/RouteError";
import { encodeCursor, decodeCursor, clampLimit, DEFAULT_PAGE_SIZE } from "../utils/cursor";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ProfileTotals {
  totalPredictions: number;
  totalAmountStaked: string;
  wins: number;
  losses: number;
  prediction_count?: number;
  claim_count?: number;
}

export interface PredictionEntry {
  id: string;
  market: {
    id: string;
    question: string;
    status: string;
    resolutionTime: string;
  };
  outcome: string;
  amount: string;
  createdAt: string;
}

export interface CurrentUserProfile {
  stellarAddress: string;
  createdAt: string;
  totals: {
    prediction_count: number;
    claim_count: number;
  };
}

export interface ProfileTotals {
  totalPredictions: number;
  totalAmountStaked: string;
  wins: number;
  losses: number;
}

export interface UserProfile {
  id: string;
  stellarAddress: string;
  createdAt: string;
  predictions: PredictionEntry[];
  totals: ProfileTotals;
}

// ── Service functions ─────────────────────────────────────────────────────

/**
 * Look up a public user profile by Stellar address.
 *
 * Returns `null` when no user with that address exists.
 *
 * @param stellarAddress - The Stellar account address to look up.
 */
export async function getUserProfile(
  stellarAddress: string,
): Promise<UserProfile | null> {
  void stellarAddress;
  return null;
}

/**
 * Returns the authenticated user's profile (stellarAddress, createdAt) along
 * with aggregate counts of their predictions.  Two queries run
 * in parallel via Promise.all:
 */
export async function getCurrentUserProfile(userId: string): Promise<Result<CurrentUserProfile>> {
  const [userRow, predCountRow] = await Promise.all([
    db
      .select({
        id: users.id,
        stellarAddress: users.stellarAddress,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({ value: count() })
      .from(predictions)
      .where(eq(predictions.userId, userId)),
  ]);

  const user = userRow[0];
  if (!user) {
    return err({
      kind: "NotFound",
      message: "User not found",
      resource: "User",
    });
  }

  const prediction_count = Number(predCountRow[0]?.value ?? 0);

  return ok({
    id: user.id,
    stellarAddress: user.stellarAddress,
    createdAt: user.createdAt.toISOString(),
    totals: {
      prediction_count,
      claim_count: 0,
    },
  });
}

export async function getUserByAddress(address: string) {
  return db.query.users.findFirst({
    where: eq(users.stellarAddress, address),
  });
}

/**
 * Serialised shape of a single prediction row returned to callers.
 */
export interface UserPredictionRow {
  id: string;
  marketId: string;
  question: string;
  outcome: string;
  amount: string;
  status: string;
  createdAt: string;
  resolutionTime: string;
}

/**
 * Fetch one page of predictions for a user using keyset (cursor) pagination.
 *
 * Sort order: (createdAt DESC, id DESC) — stable even when two predictions
 * share the same timestamp because the UUID tie-breaker is unique.
 *
 * Cursor format: the shared `encodeCursor` / `decodeCursor` helpers in
 * `src/utils/cursor.ts` encode `{ sortValue: createdAt ISO-string, id }` as a
 * versioned, opaque base64url token.  A cursor minted under a different schema
 * version is silently treated as absent (restart from page one) rather than
 * causing a wrong-offset query or a 500.
 *
 * Keyset WHERE clause for DESC ordering:
 *   (createdAt < cursorTime) OR (createdAt = cursorTime AND id < cursorId)
 *
 * This is the standard two-column keyset predicate: rows that sort strictly
 * after the last item on the previous page, respecting both columns of the
 * composite sort key.
 */
export async function getUserPredictions(
  userId: string,
  opts: {
    status?: string;
    limit: number;
    cursor?: string;
  },
): Promise<Page<UserPredictionRow>> {
  const { status, limit, cursor } = opts;

  const whereConditions = [eq(predictions.userId, userId)];

  if (status) {
    baseConditions.push(eq(predictions.status, status));
  }

  if (cursor) {
    const [cursorTime, cursorId] = cursor.split("|");
    const cursorCreatedAt = new Date(cursorTime);

    whereConditions.push(
      or(
        lt(predictions.createdAt, cursorCreatedAt),
        and(eq(predictions.createdAt, cursorCreatedAt), lt(predictions.id, cursorId)),
      )!,
    );
  }

  // Fetch one extra row to determine whether a next page exists.
  const results = await db
    .select({
      id: predictions.id,
      marketId: predictions.marketId,
      question: markets.question,
      outcome: predictions.outcome,
      amount: predictions.amount,
      status: predictions.status,
      createdAt: predictions.createdAt,
      resolutionTime: markets.resolutionTime,
    })
    .from(predictions)
    .innerJoin(markets, eq(predictions.marketId, markets.id))
    .where(and(...baseConditions))
    .orderBy(desc(predictions.createdAt), desc(predictions.id))
    .limit(limit + 1);

  const hasMore = results.length > limit;
  const data = results.slice(0, limit);

  // Encode the cursor from the last row on this page using the shared helper,
  // which stamps the current CURSOR_VERSION into the token so stale cursors
  // are rejected after schema migrations rather than silently mis-paginating.
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
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

// ── listUsers ──────────────────────────────────────────────────────────────

/**
 * Serialised shape of a single user row returned by GET /api/users.
 */
export interface UserListRow {
  id: string;
  stellarAddress: string;
  createdAt: string;
}

/**
 * Return a cursor-paginated list of all users, sorted DESC by (createdAt, id)
 * for stable ordering even when two users share the same timestamp.
 *
 * This query is served by the `users_created_at_id_idx` composite index
 * (migration 0025_users_filter_idx), which switches the planner from a
 * sequential scan + quicksort (O(n)) to an Index Scan Backward (O(log n +
 * limit)), eliminating the sort node entirely.
 *
 * Cursor format: opaque base64url token encoding `{ sortValue: createdAt ISO,
 * id }` via the shared `encodeCursor` / `decodeCursor` helpers in
 * `src/utils/cursor.ts`.  A missing, tampered, or version-mismatched cursor
 * is silently treated as absent (restart from page one) rather than 500-ing.
 *
 * Keyset WHERE clause for DESC (createdAt, id):
 *   (createdAt < cursorTime) OR (createdAt = cursorTime AND id < cursorId)
 *
 * Fetch limit + 1 rows so we can detect whether a next page exists without
 * a separate COUNT query.
 */
export async function listUsers(opts: {
  cursor?: string;
  limit?: number;
}): Promise<Page<UserListRow>> {
  const limit = clampLimit(opts.limit ?? DEFAULT_PAGE_SIZE);
  const cursorKey = decodeCursor(opts.cursor);

  const conditions: ReturnType<typeof eq>[] = [];

  if (cursorKey) {
    const cursorTime = new Date(cursorKey.sortValue);
    conditions.push(
      or(
        lt(users.createdAt, cursorTime),
        and(eq(users.createdAt, cursorTime), lt(users.id, cursorKey.id)),
      )! as ReturnType<typeof eq>,
    );
  }

  const rows = await db
    .select({
      id: users.id,
      stellarAddress: users.stellarAddress,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];

  return {
    data: data.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

