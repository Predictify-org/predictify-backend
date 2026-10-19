import { closeDb, pool } from "../../src/db/client";
import { db } from "../../src/db";
import { DrizzleMarketResolutionRepo } from "../../src/services/marketResolutionService";
import { DrizzlePredictionsConfirmerRepo } from "../../src/workers/predictionsConfirmer";
import { claimWinnings, ClaimError } from "../../src/services/claimService";
import { repairUnconfirmedResults } from "../../scripts/repair-unconfirmed-results";
import { drizzle } from "drizzle-orm/node-postgres";

async function seedUser(addr: string): Promise<string> {
  const r = await pool.query(`INSERT INTO users (stellar_address) VALUES ($1) RETURNING id`, [addr]);
  return r.rows[0].id as string;
}

async function seedMarket(id: string, status = "active", winning: string | null = null) {
  await pool.query(
    `INSERT INTO markets (id, question, status, resolution_time, indexed_ledger, archived, version, featured, winning_outcome)
     VALUES ($1, 'q', $2, now(), 1, false, 1, false, $3)`,
    [id, status, winning],
  );
}

async function seedPrediction(
  marketId: string,
  userId: string,
  outcome: string,
  status: string,
  extra: { result?: string | null; claimTx?: string | null } = {},
): Promise<string> {
  const r = await pool.query(
    `INSERT INTO predictions (market_id, user_id, outcome, amount, status, tx_hash, result, claim_tx_hash)
     VALUES ($1, $2, $3, '10', $4, $5, $6, $7) RETURNING id`,
    [marketId, userId, outcome, status, `tx-${Math.random()}`, extra.result ?? null, extra.claimTx ?? null],
  );
  return r.rows[0].id as string;
}

async function resultOf(id: string): Promise<string | null> {
  const r = await pool.query(`SELECT result FROM predictions WHERE id = $1`, [id]);
  return r.rows[0].result as string | null;
}

const suffix = Date.now().toString(36);
const builder = { submitClaimTx: jest.fn(async () => "hash") };

afterAll(async () => {
  await closeDb();
});

describe("resolution scoring (integration)", () => {
  beforeEach(() => builder.submitClaimTx.mockClear());

  it("scores only confirmed rows; replay changes nothing", async () => {
    const m = `m-score-${suffix}`;
    const u = await seedUser(`G-SCORE-${suffix}`);
    await seedMarket(m);
    const c = await seedPrediction(m, u, "YES", "confirmed");
    const p = await seedPrediction(m, u, "YES", "pending");
    const f = await seedPrediction(m, u, "YES", "failed");

    const repo = new DrizzleMarketResolutionRepo(db);
    expect(await repo.atomicResolve(m, "YES")).toBe(true);
    expect(await repo.atomicResolve(m, "NO")).toBe(false);

    expect(await resultOf(c)).toBe("won");
    expect(await resultOf(p)).toBeNull();
    expect(await resultOf(f)).toBeNull();
  });

  it("claim with only a failed winning row → 400 prediction_not_winning, no RPC", async () => {
    const m = `m-failclaim-${suffix}`;
    const u = await seedUser(`G-FAILCLAIM-${suffix}`);
    await seedMarket(m);
    await seedPrediction(m, u, "YES", "failed");
    await new DrizzleMarketResolutionRepo(db).atomicResolve(m, "YES");

    await expect(
      claimWinnings({ marketId: m, userId: u, stellarAddress: "G" }, builder),
    ).rejects.toMatchObject({ status: 400, code: "prediction_not_winning" });
    expect(builder.submitClaimTx).not.toHaveBeenCalled();
  });

  it("claim uses the confirmed row when a failed duplicate exists", async () => {
    const m = `m-dup-${suffix}`;
    const u = await seedUser(`G-DUP-${suffix}`);
    await seedMarket(m);
    await seedPrediction(m, u, "YES", "failed");
    const c = await seedPrediction(m, u, "YES", "confirmed");
    await new DrizzleMarketResolutionRepo(db).atomicResolve(m, "YES");

    const res = await claimWinnings({ marketId: m, userId: u, stellarAddress: "G" }, builder);
    expect(res.predictionId).toBe(c);
  });

  it("two confirmed rows → 409 ambiguous_prediction", async () => {
    const m = `m-amb-${suffix}`;
    const u = await seedUser(`G-AMB-${suffix}`);
    await seedMarket(m);
    await seedPrediction(m, u, "YES", "confirmed");
    await seedPrediction(m, u, "YES", "confirmed");
    await new DrizzleMarketResolutionRepo(db).atomicResolve(m, "YES");

    const err = await claimWinnings({ marketId: m, userId: u, stellarAddress: "G" }, builder).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect(err).toMatchObject({ status: 409, code: "ambiguous_prediction" });
    expect(builder.submitClaimTx).not.toHaveBeenCalled();
  });

  it("prediction confirmed after resolution is scored in the confirm update", async () => {
    const m = `m-late-${suffix}`;
    const u = await seedUser(`G-LATE-${suffix}`);
    await seedMarket(m, "resolved", "YES");
    const p = await seedPrediction(m, u, "NO", "pending");

    const repo = new DrizzlePredictionsConfirmerRepo(drizzle(pool));
    await repo.confirmBatch([p]);
    expect(await resultOf(p)).toBe("lost");
    await repo.confirmBatch([p]);
    expect(await resultOf(p)).toBe("lost");
  });

  it("repair script: dry run writes nothing; --apply resets only unclaimed non-confirmed rows", async () => {
    const m = `m-repair-${suffix}`;
    const u = await seedUser(`G-REPAIR-${suffix}`);
    await seedMarket(m, "resolved", "YES");
    const pending = await seedPrediction(m, u, "YES", "pending", { result: "won" });
    const claimed = await seedPrediction(m, u, "YES", "failed", { result: "won", claimTx: "ctx" });
    const confirmed = await seedPrediction(m, u, "YES", "confirmed", { result: "won" });

    const dry = await repairUnconfirmedResults(pool, false);
    expect(dry.reset).toBe(0);
    expect(dry.candidates).toBeGreaterThanOrEqual(1);
    expect(await resultOf(pending)).toBe("won");

    const applied = await repairUnconfirmedResults(pool, true);
    expect(applied.reset).toBeGreaterThanOrEqual(1);
    expect(applied.claimedSkipped.map((r) => r.id)).toContain(claimed);
    expect(await resultOf(pending)).toBeNull();
    expect(await resultOf(claimed)).toBe("won");
    expect(await resultOf(confirmed)).toBe("won");
  });
});
