import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { claims, markets, predictions, users } from "../db/schema";

export interface PortfolioExportMarket {
  marketId: string;
  question: string;
  status: string;
  resolutionTime: string;
  outcome: string;
  predictions: number;
  totalStaked: string;
  claimable: string;
  latestPredictionAt: string;
}

export interface PortfolioExportSummary {
  totalMarketsParticipated: number;
  totalPredictions: number;
  totalStaked: string;
  totalClaimable: string;
  outcomes: {
    won: number;
    lost: number;
    pending: number;
    confirmed: number;
    claimed: number;
  };
}

export interface PortfolioExportSnapshot {
  version: 1;
  exportedAt: string;
  address: string;
  summary: PortfolioExportSummary;
  markets: PortfolioExportMarket[];
}

function parseAmount(amount: string | null | undefined): bigint {
  if (!amount || !/^\d+$/.test(amount)) return 0n;
  return BigInt(amount);
}

function addDecimalStrings(a: string, b: string): string {
  return (parseAmount(a) + parseAmount(b)).toString();
}

export async function getPortfolioExport(address: string): Promise<PortfolioExportSnapshot | null> {
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
    claimableByMarket.set(
      row.marketId,
      addDecimalStrings(claimableByMarket.get(row.marketId) ?? "0", row.amount),
    );
  }

  const byMarket = new Map<string, PortfolioExportMarket>();
  const summary: PortfolioExportSummary = {
    totalMarketsParticipated: 0,
    totalPredictions: 0,
    totalStaked: "0",
    totalClaimable: "0",
    outcomes: {
      won: 0,
      lost: 0,
      pending: 0,
      confirmed: 0,
      claimed: 0,
    },
  };

  for (const row of predictionRows) {
    summary.totalPredictions += 1;
    summary.totalStaked = addDecimalStrings(summary.totalStaked, row.amount);

    const status = row.status as keyof typeof summary.outcomes;
    if (status in summary.outcomes) {
      summary.outcomes[status] += 1;
    }

    const createdAt = row.createdAt.toISOString();
    const existing = byMarket.get(row.marketId);
    if (existing) {
      existing.predictions += 1;
      existing.totalStaked = addDecimalStrings(existing.totalStaked, row.amount);
      if (createdAt > existing.latestPredictionAt) {
        existing.latestPredictionAt = createdAt;
      }
    } else {
      byMarket.set(row.marketId, {
        marketId: row.marketId,
        question: row.question,
        status: row.marketStatus,
        resolutionTime: row.resolutionTime.toISOString(),
        outcome: row.outcome,
        predictions: 1,
        totalStaked: row.amount,
        claimable: claimableByMarket.get(row.marketId) ?? "0",
        latestPredictionAt: createdAt,
      });
    }
  }

  summary.totalMarketsParticipated = byMarket.size;
  for (const amount of claimableByMarket.values()) {
    summary.totalClaimable = addDecimalStrings(summary.totalClaimable, amount);
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    address: user.stellarAddress,
    summary,
    markets: [...byMarket.values()].sort((a, b) =>
      b.latestPredictionAt.localeCompare(a.latestPredictionAt),
    ),
  };
}
