/**
 * Admin user-view service.
 *
 * Aggregates a user's predictions, claims, and disputes in parallel so the
 * admin endpoint returns a single, complete snapshot.  All queries are scoped
 * to the user's internal UUID, so the caller can never leak cross-user data by
 * accident — the address look-up is the only surface that touches the address.
 *
 * refresh_token / session_id columns are intentionally excluded from every
 * select projection.
 */

import { eq } from "drizzle-orm";
import { adminAuditLog, claims, disputes, predictions, users } from "../db/schema";
import type { DB } from "../db/client";

// ── Response shape ────────────────────────────────────────────────────────────

export interface AdminUserView {
  user: {
    id: string;
    stellarAddress: string;
    createdAt: string;
  } | null;
  predictions: Array<{
    id: string;
    marketId: string;
    outcome: string;
    amount: string;
    createdAt: string;
  }>;
  claims: Array<{
    id: string;
    marketId: string;
    amount: string;
    status: string;
    createdAt: string;
  }>;
  disputes: Array<{
    id: string;
    marketId: string;
    reason: string;
    status: string;
    createdAt: string;
  }>;
  totals: {
    predictions: number;
    claims: number;
    disputes: number;
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getAdminUserView(address: string, db: DB): Promise<AdminUserView> {
  const userRows = await db
    .select({
      id: users.id,
      stellarAddress: users.stellarAddress,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.stellarAddress, address))
    .limit(1);

  const user = userRows[0] ?? null;

  // Unknown address: return an empty shell so the admin sees a useful payload
  // instead of a 404 (the address may have never signed up yet).
  if (!user) {
    return {
      user: null,
      predictions: [],
      claims: [],
      disputes: [],
      totals: { predictions: 0, claims: 0, disputes: 0 },
    };
  }

  // Fetch all three relations in parallel — independent queries, no join needed
  const [userPredictions, userClaims, userDisputes] = await Promise.all([
    db
      .select({
        id: predictions.id,
        marketId: predictions.marketId,
        outcome: predictions.outcome,
        amount: predictions.amount,
        createdAt: predictions.createdAt,
      })
      .from(predictions)
      .where(eq(predictions.userId, user.id)),

    db
      .select({
        id: claims.id,
        marketId: claims.marketId,
        amount: claims.amount,
        status: claims.status,
        createdAt: claims.createdAt,
      })
      .from(claims)
      .where(eq(claims.userId, user.id)),

    db
      .select({
        id: disputes.id,
        marketId: disputes.marketId,
        reason: disputes.reason,
        status: disputes.status,
        createdAt: disputes.createdAt,
      })
      .from(disputes)
      .where(eq(disputes.openedBy, user.id)),
  ]);

  return {
    user: {
      id: user.id,
      stellarAddress: user.stellarAddress,
      createdAt: user.createdAt.toISOString(),
    },
    predictions: userPredictions.map((p) => ({
      id: p.id,
      marketId: p.marketId,
      outcome: p.outcome,
      amount: p.amount,
      createdAt: p.createdAt.toISOString(),
    })),
    claims: userClaims.map((c) => ({
      id: c.id,
      marketId: c.marketId,
      amount: c.amount,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
    })),
    disputes: userDisputes.map((d) => ({
      id: d.id,
      marketId: d.marketId,
      reason: d.reason,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
    })),
    totals: {
      predictions: userPredictions.length,
      claims: userClaims.length,
      disputes: userDisputes.length,
    },
  };
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export async function writeAuditLog(
  adminAddress: string,
  targetAddress: string,
  db: DB,
): Promise<void> {
  await db.insert(adminAuditLog).values({
    adminAddress,
    action: "read_user_view",
    targetAddress,
  });
}
