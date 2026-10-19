/**
 * Data repair: reset `result` to NULL on non-confirmed predictions in resolved
 * markets that were scored before resolution was limited to confirmed rows.
 *
 * Dry run by default (reports counts, writes nothing). Pass --apply to write.
 * Rows that already have a claim_tx_hash are reported, never modified.
 * Users with more than one confirmed row in a market are reported too, since
 * claims for them return 409 ambiguous_prediction.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/repair-unconfirmed-results.ts
 *   npx ts-node --transpile-only scripts/repair-unconfirmed-results.ts --apply
 */
import type { Pool } from "pg";

export interface RepairReport {
  applied: boolean;
  candidates: number;
  reset: number;
  claimedSkipped: Array<{ id: string; marketId: string; userId: string; claimTxHash: string }>;
  duplicateConfirmed: Array<{ marketId: string; userId: string; count: number }>;
}

export async function repairUnconfirmedResults(
  pool: Pick<Pool, "query">,
  apply: boolean,
): Promise<RepairReport> {
  const candidates = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM predictions p JOIN markets m ON m.id = p.market_id
      WHERE m.status = 'resolved' AND p.status <> 'confirmed'
        AND p.result IS NOT NULL AND p.claim_tx_hash IS NULL`,
  );

  const claimed = await pool.query(
    `SELECT p.id, p.market_id AS "marketId", p.user_id AS "userId", p.claim_tx_hash AS "claimTxHash"
       FROM predictions p JOIN markets m ON m.id = p.market_id
      WHERE m.status = 'resolved' AND p.status <> 'confirmed'
        AND p.result IS NOT NULL AND p.claim_tx_hash IS NOT NULL
      ORDER BY p.id`,
  );

  const duplicates = await pool.query(
    `SELECT market_id AS "marketId", user_id AS "userId", COUNT(*)::int AS count
       FROM predictions WHERE status = 'confirmed'
      GROUP BY market_id, user_id HAVING COUNT(*) > 1
      ORDER BY market_id, user_id`,
  );

  let reset = 0;
  if (apply) {
    const res = await pool.query(
      `UPDATE predictions p SET result = NULL
         FROM markets m
        WHERE m.id = p.market_id AND m.status = 'resolved'
          AND p.status <> 'confirmed'
          AND p.result IS NOT NULL AND p.claim_tx_hash IS NULL`,
    );
    reset = res.rowCount ?? 0;
  }

  return {
    applied: apply,
    candidates: candidates.rows[0].n as number,
    reset,
    claimedSkipped: claimed.rows,
    duplicateConfirmed: duplicates.rows,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { pool } = await import("../src/db/client");
  try {
    const report = await repairUnconfirmedResults(pool, apply);
    console.log(`mode: ${apply ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
    console.log(`non-confirmed rows with a result (unclaimed): ${report.candidates}`);
    console.log(`rows reset: ${report.reset}`);
    console.log(`claimed non-confirmed rows (reported, not modified): ${report.claimedSkipped.length}`);
    for (const r of report.claimedSkipped) {
      console.log(`  prediction=${r.id} market=${r.marketId} user=${r.userId} claimTx=${r.claimTxHash}`);
    }
    console.log(`users with multiple confirmed rows in a market: ${report.duplicateConfirmed.length}`);
    for (const d of report.duplicateConfirmed) {
      console.log(`  market=${d.marketId} user=${d.userId} confirmed=${d.count}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
