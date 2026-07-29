/**
 * statsService.ts
 *
 * Global platform statistics aggregator.
 *
 * Returns lightweight counts suitable for a public landing page or dashboard.
 * The result is intentionally small and stable — ideal for strong ETag caching
 * on the GET /api/stats endpoint.
 */

import { db } from "../db";
import { users, markets, predictions, claims } from "../db/schema";
import { eq, count } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketBreakdown {
  total: number;
  active: number;
  resolved: number;
}

export interface GlobalStats {
  users: number;
  markets: MarketBreakdown;
  predictions: number;
  claims: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns global platform statistics.
 *
 * Runs five lightweight SELECT COUNT(*) queries against the users,
 * markets, predictions, and claims tables. The result is not cached
 * in-memory — the caller (route handler) is responsible for ETag /
 * conditional GET to avoid redundant transfers.
 */
export async function getGlobalStats(): Promise<GlobalStats> {
  // Run all COUNT queries in parallel for efficiency — the result set is
  // tiny and each query is independent, so concurrency is a free win.
  const [userCount, marketTotal, activeCount, predictionCount, claimCount] =
    await Promise.all([
      db.select({ value: count() }).from(users),
      db.select({ value: count() }).from(markets),
      db
        .select({ value: count() })
        .from(markets)
        .where(eq(markets.status, "active")),
      db.select({ value: count() }).from(predictions),
      db.select({ value: count() }).from(claims),
    ]);

  const totalMarkets = Number(marketTotal[0]?.value ?? 0);
  const activeMarkets = Number(activeCount[0]?.value ?? 0);

  return {
    users: Number(userCount[0]?.value ?? 0),
    markets: {
      total: totalMarkets,
      active: activeMarkets,
      resolved: totalMarkets - activeMarkets,
    },
    predictions: Number(predictionCount[0]?.value ?? 0),
    claims: Number(claimCount[0]?.value ?? 0),
  };
}
