import { db } from "../db";
import { markets, marketAuditLog } from "../db/schema";
import { eq } from "drizzle-orm";

export interface Market {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  metadata: any;
  indexedLedger: number;
  archived: boolean;
  version: number;
}

export class VersionConflictError extends Error {
  status = 409;
  code = "version_conflict";
  constructor() {
    super("Version conflict");
    Object.setPrototypeOf(this, VersionConflictError.prototype);
  }
}

export async function listMarkets(): Promise<any[]> {
  return await db.select().from(markets);
}

export async function getMarketById(id: string): Promise<any | null> {
  const result = await db.select().from(markets).where(eq(markets.id, id)).limit(1);
  return result[0] || null;
}

export async function updateMarket(
  id: string,
  patch: { question?: string; metadata?: any },
  expectedVersion: number,
  adminAddress: string
): Promise<any> {
  return await db.transaction(async (tx) => {
    const existing = await tx.select().from(markets).where(eq(markets.id, id)).limit(1);
    if (existing.length === 0) {
      const err = new Error("Market not found");
      (err as any).status = 404;
      throw err;
    }

    const currentMarket = existing[0];
    if (currentMarket.version !== expectedVersion) {
      throw new VersionConflictError();
    }

    const newVersion = expectedVersion + 1;
    const updated = await tx
      .update(markets)
      .set({
        ...patch,
        version: newVersion,
      })
      .where(eq(markets.id, id))
      .returning();

    await tx.insert(marketAuditLog).values({
      marketId: id,
      adminAddress,
      action: "update",
      beforeState: {
        question: currentMarket.question,
        metadata: currentMarket.metadata,
        version: currentMarket.version,
      },
      afterState: {
        question: updated[0].question,
        metadata: updated[0].metadata,
        version: updated[0].version,
      },
    });

    return updated[0];
  });
}

