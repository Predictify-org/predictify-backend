/**
 * Per-prediction statistics.
 *
 * Aggregates the predictions on the same market to derive how a single
 * prediction is positioned relative to its peers:
 *   - pool totals (overall and per outcome)
 *   - the share of the winning-side pool this prediction represents
 *   - its stake-rank among predictions that backed the same outcome
 *   - an expected payout under a parimutuel (pool-share) model: if the
 *     prediction's outcome wins, the whole market pool is split pro-rata
 *     across the stakes on that outcome.
 *
 * The parimutuel model is intentionally simple — it gives the caller a useful
 * "what would I win" estimate without depending on on-chain settlement rules.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { predictions, markets } from "../db/schema";
import { NotFoundError } from "../errors";

export interface PredictionStats {
  prediction: {
    id: string;
    marketId: string;
    outcome: string;
    amount: string;
    status: string;
  };
  market: {
    id: string;
    question: string;
    status: string;
  };
  totals: {
    predictions: number;
    pool: string;
    outcomePool: string;
  };
  ranking: {
    /** 1-based rank of this prediction's stake among same-outcome predictions. */
    rank: number;
    outOf: number;
  };
  /** Fraction (0..1) of the winning-outcome pool this prediction represents. */
  outcomeShare: number;
  /** Estimated payout if this prediction's outcome wins (parimutuel). */
  expectedPayout: string;
}

/** Parse a stake string into a finite number, defaulting to 0 on garbage. */
function toAmount(raw: string): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function getPredictionStats(predictionId: string): Promise<PredictionStats> {
  const [prediction] = await db
    .select()
    .from(predictions)
    .where(eq(predictions.id, predictionId))
    .limit(1);

  if (!prediction) {
    throw new NotFoundError(`Prediction ${predictionId} not found`);
  }

  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, prediction.marketId))
    .limit(1);

  if (!market) {
    throw new NotFoundError(`Market ${prediction.marketId} not found`);
  }

  // All predictions on the same market drive the pool maths.
  const siblings = await db
    .select({
      id: predictions.id,
      outcome: predictions.outcome,
      amount: predictions.amount,
    })
    .from(predictions)
    .where(eq(predictions.marketId, prediction.marketId));

  const myAmount = toAmount(prediction.amount);
  let pool = 0;
  let outcomePool = 0;
  const sameOutcome: number[] = [];

  for (const s of siblings) {
    const amt = toAmount(s.amount);
    pool += amt;
    if (s.outcome === prediction.outcome) {
      outcomePool += amt;
      sameOutcome.push(amt);
    }
  }

  // Rank: number of same-outcome stakes strictly greater than mine, plus one.
  const rank = sameOutcome.filter((a) => a > myAmount).length + 1;
  const outcomeShare = outcomePool > 0 ? myAmount / outcomePool : 0;
  const expectedPayout = outcomePool > 0 ? pool * outcomeShare : myAmount;

  return {
    prediction: {
      id: prediction.id,
      marketId: prediction.marketId,
      outcome: prediction.outcome,
      amount: prediction.amount,
      status: prediction.status,
    },
    market: {
      id: market.id,
      question: market.question,
      status: market.status,
    },
    totals: {
      predictions: siblings.length,
      pool: pool.toString(),
      outcomePool: outcomePool.toString(),
    },
    ranking: {
      rank,
      outOf: sameOutcome.length,
    },
    outcomeShare,
    expectedPayout: expectedPayout.toString(),
  };
}
