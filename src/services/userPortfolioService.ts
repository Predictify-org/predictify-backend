import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { claims, markets, predictions, users } from "../db/schema";

const CACHE_TTL_MS = 30_000;

type CacheEntry = { expiresAt: number; value: UserPortfolio };
const cache = new Map<string, CacheEntry>();

export interface UserPortfolioMarket {
  marketId: string;
  question: string;
  status: string;
  resolutionTime: string;
  outcome: string;
  predictionCount: number;
  totalStaked: string;
  claimableAmount: string;
  latestPredictionAt: string;
}

export interface UserPortfolio {
  address: string;
  totals: {
    marketCount: number;
    predictionCount: number;
    totalStaked: string;
    claimableAmount: string;
    won: number;
    lost: number;
    pending: number;
    confirmed: number;
    claimed: number;
  };
  markets: UserPortfolioMarket[];
  cachedAt: string;
}

function parseAmount(amount: string | null | undefined): bigint {
  if (!amount || !/^\d+$/.test(amount)) return 0n;
  return BigInt(amount);
}

function addDecimalStrings(a: string, b: string): string {
  return (parseAmount(a) + parseAmount(b)).toString();
}

export function clearUserPortfolioCache(): void {
  cache.clear();
}

export async function getUserPortfolio(address: string): Promise<UserPortfolio | null> {
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
        question: markets.question,
        marketStatus: markets.status,
        resolutionTime: markets.resolutionTime,
        outcome: predictions.outcome,
        amount: predictions.amount,
        status: predictions.status,
        createdAt: predictions.createdAt,
      })
      .from(predictions)
      .innerJoin(markets, eq(predictions.marketId, markets.id))
      .where(eq(predictions.userId, user.id)),
    db
      .select({ marketId: claims.marketId, amount: claims.amount })
      .from(claims)
      .where(and(eq(claims.userId, user.id), eq(claims.status, "pending"))),
  ]);

  const claimableByMarket = new Map<string, string>();
  for (const row of claimRows) {
    claimableByMarket.set(row.marketId, addDecimalStrings(claimableByMarket.get(row.marketId) ?? "0", row.amount));
  }

  const byMarket = new Map<string, UserPortfolioMarket>();
  const totals = {
    marketCount: 0,
    predictionCount: 0,
    totalStaked: "0",
    claimableAmount: "0",
    won: 0,
    lost: 0,
    pending: 0,
    confirmed: 0,
    claimed: 0,
  };

  for (const row of predictionRows) {
    totals.predictionCount += 1;
    totals.totalStaked = addDecimalStrings(totals.totalStaked, row.amount);
    if (row.status in totals && typeof totals[row.status as keyof typeof totals] === "number") {
      (totals[row.status as "won" | "lost" | "pending" | "confirmed" | "claimed"] as number) += 1;
    }

    const createdAt = row.createdAt.toISOString();
    const existing = byMarket.get(row.marketId);
    if (existing) {
      existing.predictionCount += 1;
      existing.totalStaked = addDecimalStrings(existing.totalStaked, row.amount);
      if (createdAt > existing.latestPredictionAt) existing.latestPredictionAt = createdAt;
    } else {
      byMarket.set(row.marketId, {
        marketId: row.marketId,
        question: row.question,
        status: row.marketStatus,
        resolutionTime: row.resolutionTime.toISOString(),
        outcome: row.outcome,
        predictionCount: 1,
        totalStaked: row.amount,
        claimableAmount: claimableByMarket.get(row.marketId) ?? "0",
        latestPredictionAt: createdAt,
      });
    }
  }

  totals.marketCount = byMarket.size;
  for (const amount of claimableByMarket.values()) {
    totals.claimableAmount = addDecimalStrings(totals.claimableAmount, amount);
  }

  const value = {
    address: user.stellarAddress,
    totals,
    markets: [...byMarket.values()].sort((a, b) => b.latestPredictionAt.localeCompare(a.latestPredictionAt)),
    cachedAt: new Date(now).toISOString(),
  };
  cache.set(address, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
