import { db } from "../db/connection";
import { users, predictions, markets } from "../db/schema";
import { and, eq, desc, lt } from "drizzle-orm";

export interface UserPrediction {
  id: string;
  marketId: string;
  question: string;
  outcome: string;
  amount: string;
  status: "pending" | "confirmed" | "won" | "lost" | "claimed";
  createdAt: string;
  resolutionTime: string;
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

  let whereConditions = [eq(predictions.userId, userId)];

  // Apply status filter if provided
  if (status) {
    whereConditions.push(eq(predictions.status, status));
  }

  // Apply cursor for pagination (keysett pagination on created_at DESC, id)
  if (cursor) {
    const [cursorTime, cursorId] = cursor.split("|");
    whereConditions.push(lt(predictions.createdAt, new Date(cursorTime)));
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
    .limit(limit + 1); // +1 to detect if there are more results

  const hasMore = results.length > limit;
  const data = results.slice(0, limit);

  // Generate next cursor from last result
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
