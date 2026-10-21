/**
 * Confirmer join tests (issue #979, test plan rows 8 and 9).
 *
 * DrizzlePredictionsConfirmerRepo is driven through a real drizzle instance
 * over a fake pg pool that records the SQL it is asked to run.  There is no
 * Postgres in the unit-test environment, so these tests pin the exact query
 * contract (which rows may confirm a prediction); the SQL itself is not
 * executed here.
 *
 *  Row 8: a pending prediction whose tx only has an `unknown:*` event must not
 *         be confirmed  -> the confirming join must require event_type 'bet_plc'.
 *  Row 9: a bet_plc whose bettor is not the prediction's user must not confirm
 *         -> the join must compare data->>'bettor' with the user's address.
 */

import { drizzle } from "drizzle-orm/node-postgres";

import { DrizzlePredictionsConfirmerRepo } from "../src/workers/predictionsConfirmer";

interface Captured {
  text: string;
  values: unknown[];
}

function makeRepo(): { repo: DrizzlePredictionsConfirmerRepo; captured: Captured[] } {
  const captured: Captured[] = [];
  const pool = {
    query: jest.fn(async (q: { text: string; values?: unknown[] } | string, v?: unknown[]) => {
      const text = typeof q === "string" ? q : q.text;
      const values = v ?? (typeof q === "string" ? [] : (q.values ?? []));
      captured.push({ text, values });
      return { rows: [], rowCount: 0, fields: [] };
    }),
  };
  const db = drizzle(pool as never);
  return { repo: new DrizzlePredictionsConfirmerRepo(db), captured };
}

const normalise = (sql: string): string => sql.replace(/\s+/g, " ");

describe("DrizzlePredictionsConfirmerRepo confirming-event join", () => {
  it("row 8: findConfirmedCandidateIds only matches canonical bet_plc events (unknown:* never confirms)", async () => {
    const { repo, captured } = makeRepo();
    await repo.findConfirmedCandidateIds(10);

    expect(captured).toHaveLength(1);
    const sql = normalise(captured[0].text);
    expect(sql).toContain(`"indexer_events"."event_type" =`);
    expect(sql).toContain(`"indexer_events"."canonical" = TRUE`);
    expect(captured[0].values).toContain("bet_plc");
    // An event row with another type (e.g. 'unknown:foo_bar') cannot satisfy
    // the equality above, and a tx_hash-only match is no longer sufficient.
    expect(sql).not.toMatch(/inner join "indexer_events" on "predictions"."tx_hash" = "indexer_events"."tx_hash"\s+where/i);
  });

  it("row 9: findConfirmedCandidateIds requires market and bettor to match the prediction", async () => {
    const { repo, captured } = makeRepo();
    await repo.findConfirmedCandidateIds(10);

    const sql = normalise(captured[0].text);
    expect(sql).toContain(`"indexer_events"."market_id" = "predictions"."market_id"`);
    expect(sql).toContain(`"indexer_events"."data"->>'bettor' = (`);
    expect(sql).toContain(`SELECT "users"."stellar_address" FROM "users" WHERE "users"."id" = "predictions"."user_id"`);
  });

  it("incrementAttempts and markFailed use the same predicate, so unconfirmable predictions still age out", async () => {
    const { repo, captured } = makeRepo();
    await repo.incrementAttempts(3, 10);
    await repo.markFailed(3, 10);

    expect(captured).toHaveLength(2);
    for (const { text, values } of captured) {
      const sql = normalise(text);
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain(`"indexer_events"."canonical" = TRUE`);
      expect(sql).toContain(`"indexer_events"."data"->>'bettor'`);
      expect(values).toContain("bet_plc");
    }
  });
});
