import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { claims, predictions, users } from "../db/schema";
import { getRequestId } from "../lib/requestContext";
import { logger } from "../config/logger";

const CACHE_TTL_MS = 30_000;

type CacheEntry = { expiresAt: number; value: UserStats };
const cache = new Map<string, CacheEntry>();

export interface UserStats {
  address: string;
  totalPredictions: number;
  totalStaked: string;
  marketsParticipated: number;
  byStatus: {
    won: number;
    lost: number;
    pending: number;
    confirmed: number;
    claimed: number;
  };
  totalClaimed: string;
  winRate: number;
  cachedAt: string;
}

function addDecimalStrings(a: string, b: string): string {
  if (!a && !b) return "0";
  if (!a || !/^\d+$/.test(a)) return b && /^\d+$/.test(b) ? b : "0";
  if (!b || !/^\d+$/.test(b)) return a;
  return (BigInt(a) + BigInt(b)).toString();
}

export function clearUserStatsCache(): void {
  cache.clear();
}

export async function getUserStats(address: string): Promise<UserStats | null> {
  const now = Date.now();
  const cached = cache.get(address);
  if (cached && cached.expiresAt > now) return cached.value;

  const db = getDb();
  const userRows = await db
    .select({ id: users.id, stellarAddress: users.stellarAddress })
    .from(users)
    .where(eq(users.stellarAddress, address))
    .limit(1);
  const user = userRows[0];
  if (!user) return null;

  const [predictionRows, claimRows] = await Promise.all([
    db
      .select({
        id: predictions.id,
        marketId: predictions.marketId,
        amount: predictions.amount,
        status: predictions.status,
      })
      .from(predictions)
      .where(eq(predictions.userId, user.id)),
    db
      .select({ amount: claims.amount })
      .from(claims)
      .where(eq(claims.userId, user.id)),
  ]);

  const byStatus = { won: 0, lost: 0, pending: 0, confirmed: 0, claimed: 0 };
  let totalStaked = "0";
  const markets = new Set<string>();

  for (const row of predictionRows) {
    totalStaked = addDecimalStrings(totalStaked, row.amount);
    markets.add(row.marketId);

    const key = row.status as keyof typeof byStatus;
    if (key in byStatus) {
      byStatus[key] += 1;
    }
  }

  let totalClaimed = "0";
  for (const row of claimRows) {
    totalClaimed = addDecimalStrings(totalClaimed, row.amount);
  }

  const resolvedTotal = byStatus.won + byStatus.lost;
  const winRate = resolvedTotal > 0 ? byStatus.won / resolvedTotal : 0;

  const stats: UserStats = {
    address: user.stellarAddress,
    totalPredictions: predictionRows.length,
    totalStaked,
    marketsParticipated: markets.size,
    byStatus,
    totalClaimed,
    winRate,
    cachedAt: new Date(now).toISOString(),
  };

  cache.set(address, { value: stats, expiresAt: now + CACHE_TTL_MS });

  logger.info(
    { reqId: getRequestId(), address, totalPredictions: predictionRows.length, winRate },
    "Computed user stats",
  );

  return stats;
}
