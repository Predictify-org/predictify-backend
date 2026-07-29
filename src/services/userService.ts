import { db } from "../db/client";
import { users, predictions, markets, claims } from "../db/schema";
import { and, eq, desc, lt, count, or } from "drizzle-orm";
import { Result, ok, err } from "../errors/RouteError";

// ── Types ─────────────────────────────────────────────────────────────────

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

export interface ProfileTotals {
  totalPredictions: number;
  totalAmountStaked: string;
  wins: number;
  losses: number;
}

export interface UserProfile {
  id: string;
  stellarAddress: string;
  joinedAt: string;
  predictions: PredictionEntry[];
  totals: ProfileTotals;
}

export async function getUserProfile(
  stellarAddress: string,
): Promise<UserProfile | null> {
  void stellarAddress;
  return null;
}

export interface CurrentUserProfile {
  stellarAddress: string;
  createdAt: string;
  totals: {
    prediction_count: number;
    claim_count: number;
  };
}

export async function getCurrentUserProfile(userId: string): Promise<Result<CurrentUserProfile>> {
  const [userRow, predCountRow, claimCountRow] = await Promise.all([
    db
      .select({
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
    db
      .select({ value: count() })
      .from(claims)
      .where(eq(claims.userId, userId)),
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
  const claim_count = Number(claimCountRow[0]?.value ?? 0);

  return ok({
    stellarAddress: user.stellarAddress,
    createdAt: user.createdAt.toISOString(),
    totals: {
      prediction_count,
      claim_count,
    },
  });
}

export async function getUserByAddress(address: string) {
  return db.query.users.findFirst({
    where: eq(users.stellarAddress, address),
  });
}

export async function getUserPredictions(
  userId: string,
  opts: {
    status?: string;
    limit: number;
    cursor?: string;
  }
) {
  const { status, limit, cursor } = opts;

  const whereConditions = [eq(predictions.userId, userId)];

  if (status) {
    whereConditions.push(eq(predictions.status, status));
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
    .where(and(...whereConditions))
    .orderBy(desc(predictions.createdAt), desc(predictions.id))
    .limit(limit + 1);

  const hasMore = results.length > limit;
  const data = results.slice(0, limit);

  let nextCursor = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = `${last.createdAt.toISOString()}|${last.id}`;
  }

  return {
    data: data.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      resolutionTime: r.resolutionTime.toISOString(),
    })),
    nextCursor,
  };
}
