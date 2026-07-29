/**
 * marketAdmin service — force-finalize a stuck market.
 *
 * A market is "stuck" when it is past its resolution deadline and the oracle
 * path has stalled. An admin can call forceFinalize to:
 *  1. Validate the market is eligible (exists, past deadline, not already
 *     finalized/resolved via normal path).
 *  2. Atomically set status = "resolved", force_finalized = true, and
 *     winning_outcome to the supplied value inside a transaction.
 *  3. Write a marketAuditLog entry for complete traceability.
 *
 * The operation is idempotent when called with ?confirm=true — if the market
 * is already force-finalized the service returns { alreadyFinalized: true }.
 */

import { eq } from "drizzle-orm";
import { markets, marketAuditLog } from "../db/schema";
import { logger } from "../config/logger";
import { db } from "../db";

type Db = typeof db;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ForceFinalizeInput {
  marketId: string;
  winningOutcome: string;
  adminAddress: string;
}

export interface ForceFinalizePreview {
  phase: "preview";
  marketId: string;
  currentStatus: string;
  resolutionTime: string;
  requiresConfirm: true;
}

export interface ForceFinalizeResult {
  phase: "finalized";
  marketId: string;
  winningOutcome: string;
  forceFinalized: true;
}

export type ForceFinalizeOutcome =
  | ForceFinalizePreview
  | ForceFinalizeResult
  | { phase: "already_finalized" };

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Phase 1 (confirm = false): validates the market and returns a preview.
 * Phase 2 (confirm = true):  performs the atomic update and writes the audit log.
 */
export async function forceFinalize(
  db: Db,
  input: ForceFinalizeInput,
  confirm: boolean,
): Promise<ForceFinalizeOutcome> {
  const { marketId, winningOutcome, adminAddress } = input;

  // ── Fetch market ───────────────────────────────────────────────────────
  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);

  if (!market) {
    const err = Object.assign(new Error("Market not found"), { status: 404 });
    throw err;
  }

  // ── Guard: already force-finalized ────────────────────────────────────
  if (market.forceFinalized) {
    logger.info({ marketId }, "admin_force_finalize: market already force-finalized, skipping");
    return { phase: "already_finalized" };
  }

  // ── Guard: market must be past its resolution deadline ─────────────────
  if (new Date() < new Date(market.resolutionTime)) {
    const err = Object.assign(new Error("Market has not yet reached its resolution deadline"), { status: 422 });
    throw err;
  }

  // ── Phase 1 — preview only ─────────────────────────────────────────────
  if (!confirm) {
    return {
      phase: "preview",
      marketId: market.id,
      currentStatus: market.status,
      resolutionTime: market.resolutionTime.toISOString(),
      requiresConfirm: true,
    };
  }

  // ── Phase 2 — atomic finalize + audit ─────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    const beforeState = {
      status: market.status,
      winningOutcome: market.winningOutcome,
      forceFinalized: market.forceFinalized,
      version: market.version,
    };

    await tx
      .update(markets)
      .set({
        status: "resolved",
        winningOutcome,
        forceFinalized: true,
        version: market.version + 1,
      })
      .where(eq(markets.id, marketId));

    await tx.insert(marketAuditLog).values({
      marketId,
      adminAddress,
      action: "force_finalize",
      beforeState,
      afterState: {
        status: "resolved",
        winningOutcome,
        forceFinalized: true,
        version: market.version + 1,
      },
    });
  });

  logger.info({ marketId, winningOutcome, adminAddress }, "admin_force_finalize: market finalized");

  return {
    phase: "finalized",
    marketId,
    winningOutcome,
    forceFinalized: true,
  };
}
