import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { disputes, markets, predictions } from "../db/schema";
import { emitWebhook } from "./webhookService";

export interface OpenDisputeInput {
  marketId: string;
  userId: string;
  reason: string;
  evidenceUri?: string | null;
}

interface DisputeRow {
  id: string;
  marketId: string;
  openedBy: string;
  reason: string;
  evidenceUri: string | null;
  status: string;
  createdAt: Date;
}

export class DisputeError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "DisputeError";
  }
}

export async function openDispute(input: OpenDisputeInput): Promise<DisputeRow> {
  const { marketId, userId, reason, evidenceUri } = input;

  const market = await db.query.markets.findFirst({
    where: eq(markets.id, marketId),
  });
  if (!market) {
    throw new DisputeError(404, "market_not_found", "Market not found");
  }

  const prediction = await db.query.predictions.findFirst({
    where: and(
      eq(predictions.marketId, marketId),
      eq(predictions.userId, userId),
    ),
  });
  if (!prediction) {
    throw new DisputeError(403, "no_prediction", "Caller does not hold a confirmed prediction in this market");
  }

  const existing = await db.query.disputes.findFirst({
    where: and(
      eq(disputes.marketId, marketId),
      eq(disputes.openedBy, userId),
      eq(disputes.status, "open"),
    ),
  });
  if (existing) {
    throw new DisputeError(409, "duplicate_dispute", "An open dispute already exists for this user and market");
  }

  const [dispute] = await db.insert(disputes).values({
    marketId,
    openedBy: userId,
    reason,
    evidenceUri: evidenceUri ?? null,
    status: "open",
  }).returning();

  await db.update(markets)
    .set({ status: "disputed" })
    .where(eq(markets.id, marketId));

  await emitWebhook({
    type: "dispute.opened",
    marketId,
    disputeId: dispute.id,
    openedBy: userId,
    reason,
    evidenceUri: evidenceUri ?? null,
    timestamp: dispute.createdAt.toISOString(),
  });

  return dispute;
}
