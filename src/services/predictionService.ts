import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { predictions, markets } from "../db/schema";
import { NotFoundError, MarketClosedError } from "../errors";

export interface Prediction {
  id: string;
  marketId: string;
  userId: string;
  outcome: string;
  amount: string;
  txHash: string;
  status: string;
  createdAt: Date;
}

export async function createPrediction(params: {
  marketId: string;
  userId: string;
  outcome: string;
  amount: string;
  txHash: string;
}): Promise<Prediction> {
  const { marketId, userId, outcome, amount, txHash } = params;

  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);

  if (!market) {
    throw new NotFoundError("Market not found");
  }

  if (market.status !== "active") {
    throw new MarketClosedError();
  }

  if (new Date(market.resolutionTime) <= new Date()) {
    throw new MarketClosedError();
  }

  const [existing] = await db
    .select()
    .from(predictions)
    .where(
      and(
        eq(predictions.userId, userId),
        eq(predictions.marketId, marketId),
        eq(predictions.txHash, txHash),
      ),
    )
    .limit(1);

  if (existing) {
    return existing;
  }

  const [prediction] = await db
    .insert(predictions)
    .values({
      marketId,
      userId,
      outcome,
      amount,
      txHash,
      status: "pending",
    })
    .returning();

  return prediction;
}

export async function getUserPredictions(params: {
  marketId: string;
  userId: string;
}): Promise<Prediction[]> {
  const { marketId, userId } = params;

  return db
    .select()
    .from(predictions)
    .where(
      and(
        eq(predictions.marketId, marketId),
        eq(predictions.userId, userId),
      ),
    );
}
