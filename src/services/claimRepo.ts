/**
 * claimRepo.ts — Drizzle implementation of the claim persistence port.
 */

import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import { claims, markets, predictions } from "../db/schema";
import type {
    ClaimContext,
    ClaimRecord,
    ClaimRepo,
    ClaimStatus,
    NewPreparedClaim,
    TransitionPatch,
} from "./claimService";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === UNIQUE_VIOLATION || e?.cause?.code === UNIQUE_VIOLATION;
}

type ClaimRow = typeof claims.$inferSelect;

function toRecord(row: ClaimRow): ClaimRecord {
    return {
        id: row.id,
        userId: row.userId,
        marketId: row.marketId,
        amount: row.amount,
        status: row.status as ClaimStatus,
        settlementTx: row.settlementTx,
        claimNonce: row.claimNonce,
        expectedTxHash: row.expectedTxHash,
        preparedXdr: row.preparedXdr,
        expiresAt: row.expiresAt,
        errorCode: row.errorCode,
        createdAt: row.createdAt,
    };
}

export class DrizzleClaimRepo implements ClaimRepo {
    async loadContext(marketId: string, userId: string): Promise<ClaimContext> {
        const [market] = await db
            .select({ status: markets.status })
            .from(markets)
            .where(eq(markets.id, marketId))
            .limit(1);
        const [prediction] = await db
            .select({
                id: predictions.id,
                result: predictions.result,
                amount: predictions.amount,
                claimTxHash: predictions.claimTxHash,
                claimedAt: predictions.claimedAt,
            })
            .from(predictions)
            .where(and(eq(predictions.marketId, marketId), eq(predictions.userId, userId)))
            .limit(1);
        return { market: market ?? null, prediction: prediction ?? null };
    }

    async findActiveClaim(userId: string, marketId: string): Promise<ClaimRecord | null> {
        const [row] = await db
            .select()
            .from(claims)
            .where(
                and(
                    eq(claims.userId, userId),
                    eq(claims.marketId, marketId),
                    inArray(claims.status, ["prepared", "submitting", "paid", "settled"]),
                ),
            )
            .limit(1);
        return row ? toRecord(row) : null;
    }

    async hasConsumedNonce(userId: string, marketId: string): Promise<boolean> {
        const [row] = await db
            .select({ id: claims.id })
            .from(claims)
            .where(
                and(
                    eq(claims.userId, userId),
                    eq(claims.marketId, marketId),
                    inArray(claims.status, ["paid", "settled"]),
                ),
            )
            .limit(1);
        return Boolean(row);
    }

    async insertPrepared(input: NewPreparedClaim): Promise<ClaimRecord | null> {
        try {
            const [row] = await db
                .insert(claims)
                .values({ ...input, status: "prepared" })
                .returning();
            return toRecord(row);
        } catch (err) {
            if (isUniqueViolation(err)) return null;
            throw err;
        }
    }

    async findById(id: string): Promise<ClaimRecord | null> {
        const [row] = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
        return row ? toRecord(row) : null;
    }

    async transition(
        id: string,
        from: ClaimStatus,
        to: ClaimStatus,
        patch: TransitionPatch = {},
    ): Promise<ClaimRecord | null> {
        const conditions = [eq(claims.id, id), eq(claims.status, from)];
        if (patch.notExpiredAt) conditions.push(gt(claims.expiresAt, patch.notExpiredAt));
        const [row] = await db
            .update(claims)
            .set({
                status: to,
                ...(patch.settlementTx !== undefined && { settlementTx: patch.settlementTx }),
                ...(patch.errorCode !== undefined && { errorCode: patch.errorCode }),
            })
            .where(and(...conditions))
            .returning();
        return row ? toRecord(row) : null;
    }

    async recordPredictionClaim(
        userId: string,
        marketId: string,
        txHash: string,
        claimedAt: Date,
    ): Promise<void> {
        await db
            .update(predictions)
            .set({ claimTxHash: txHash, claimedAt })
            .where(and(eq(predictions.userId, userId), eq(predictions.marketId, marketId)));
    }
}
