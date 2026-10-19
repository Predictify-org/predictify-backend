import { pool, closeDb } from "../../src/db/client";
import {
  IndexerService,
  formatEventId,
} from "../../src/services/indexerService";

describe("Indexer Persistence Integration Tests", () => {
  let service: IndexerService;

  beforeAll(async () => {
    service = new IndexerService({
      getLatestLedger: jest.fn().mockResolvedValue(100),
      getEvents: jest.fn().mockResolvedValue([]),
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM indexer_reorgs");
    await pool.query("DELETE FROM indexer_events");
    await pool.query("DELETE FROM predictions");
    await pool.query("DELETE FROM markets");
    await pool.query("DELETE FROM users");
  });

  async function seedUser(address: string): Promise<string> {
    const res = await pool.query(
      "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
      [address],
    );
    return res.rows[0].id;
  }

  async function seedMarket(marketId: string): Promise<void> {
    await pool.query(
      `INSERT INTO markets (id, question, status, resolution_time, indexed_ledger, archived, version, featured)
       VALUES ($1, 'Test Market?', 'active', NOW() + INTERVAL '1 day', 1, false, 1, false)`,
      [marketId],
    );
  }

  async function seedPrediction(
    txHash: string,
    marketId: string,
    userId: string,
    status = "confirmed",
  ): Promise<string> {
    const res = await pool.query(
      `INSERT INTO predictions (market_id, user_id, outcome, amount, status, tx_hash)
       VALUES ($1, $2, 'YES', '10.0', $3, $4)
       RETURNING id`,
      [marketId, userId, status, txHash],
    );
    return res.rows[0].id;
  }

  it("Scenario 1: Insert one event against real Postgres - canonical is true and market_id is populated", async () => {
    const userId = await seedUser("GA1111111111111111111111111111111111111111111111111111111111");
    const marketId = "market-persistent-1";
    await seedMarket(marketId);
    await seedPrediction("tx-1", marketId, userId, "confirmed");

    const eventId = formatEventId(100, 1, 0, 0);
    const report = await service.persistEventsWithRecovery([
      {
        id: eventId,
        ledger: 100,
        txHash: "tx-1",
        eventType: "bet_placed",
        marketId,
        payload: { amount: "10" },
      },
    ]);

    expect(report.inserted).toBe(1);
    expect(report.replacements).toBe(0);

    const rows = await pool.query(
      `SELECT ledger, tx_hash, tx_application_order, op_index, event_index, event_type, market_id, canonical
       FROM indexer_events WHERE tx_hash = $1`,
      ["tx-1"],
    );

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row.canonical).toBe(true);
    expect(row.market_id).toBe(marketId);
    expect(row.ledger).toBe(100);
    expect(row.tx_application_order).toBe(1);
    expect(row.op_index).toBe(0);
    expect(row.event_index).toBe(0);
  });

  it("Scenario 2: Two different txs in same ledger, both with event-id suffix 0000000000 - two canonical rows, 0 reorgs, predictions untouched", async () => {
    const u1 = await seedUser("GA2222222222222222222222222222222222222222222222222222222222");
    const u2 = await seedUser("GA3333333333333333333333333333333333333333333333333333333333");
    const marketId = "market-shared-ledger";
    await seedMarket(marketId);
    const p1 = await seedPrediction("tx-bet-1", marketId, u1, "confirmed");
    const p2 = await seedPrediction("tx-bet-2", marketId, u2, "confirmed");

    // Both have suffix 0000000000, but distinct TOID txApplicationOrder (1 vs 2)
    const eventId1 = formatEventId(200, 1, 0, 0); // suffix 0000000000
    const eventId2 = formatEventId(200, 2, 0, 0); // suffix 0000000000

    const report = await service.persistEventsWithRecovery([
      { id: eventId1, ledger: 200, txHash: "tx-bet-1", marketId },
      { id: eventId2, ledger: 200, txHash: "tx-bet-2", marketId },
    ]);

    expect(report.inserted).toBe(2);
    expect(report.replacements).toBe(0);
    expect(report.repairedPredictions).toBe(0);

    const events = await pool.query(
      `SELECT tx_hash, canonical FROM indexer_events WHERE ledger = 200 ORDER BY tx_application_order`,
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0].canonical).toBe(true);
    expect(events.rows[1].canonical).toBe(true);

    const reorgs = await pool.query("SELECT * FROM indexer_reorgs WHERE ledger = 200");
    expect(reorgs.rows).toHaveLength(0);

    const predRows = await pool.query(
      `SELECT id, status FROM predictions WHERE id IN ($1, $2) ORDER BY tx_hash`,
      [p1, p2],
    );
    expect(predRows.rows[0].status).toBe("confirmed");
    expect(predRows.rows[1].status).toBe("confirmed");
  });

  it("Scenario 3: The same page delivered twice - no extra rows, no reorg rows", async () => {
    const eventId = formatEventId(300, 1, 0, 0);
    const batch = [{ id: eventId, ledger: 300, txHash: "tx-idempotent" }];

    const first = await service.persistEventsWithRecovery(batch);
    expect(first.inserted).toBe(1);
    expect(first.replacements).toBe(0);

    const second = await service.persistEventsWithRecovery(batch);
    expect(second.inserted).toBe(0);
    expect(second.replacements).toBe(0);
    expect(second.repairedPredictions).toBe(0);

    const events = await pool.query(
      "SELECT * FROM indexer_events WHERE ledger = 300",
    );
    expect(events.rows).toHaveLength(1);

    const reorgs = await pool.query(
      "SELECT * FROM indexer_reorgs WHERE ledger = 300",
    );
    expect(reorgs.rows).toHaveLength(0);
  });

  it("Scenario 4: A real replacement: same TOID position, different tx hash - marks old row non-canonical, 1 reorg row, resets prediction", async () => {
    const userId = await seedUser("GA4444444444444444444444444444444444444444444444444444444444");
    const marketId = "market-reorg";
    await seedMarket(marketId);
    await seedPrediction("tx-fork-a", marketId, userId, "confirmed");

    const eventId = formatEventId(400, 1, 0, 0);

    // Initial event canonicalized
    await service.persistEventsWithRecovery([
      { id: eventId, ledger: 400, txHash: "tx-fork-a", marketId },
    ]);

    // Chain reorg at same TOID position with new transaction
    const reorgReport = await service.persistEventsWithRecovery([
      { id: eventId, ledger: 400, txHash: "tx-fork-b", marketId },
    ]);

    expect(reorgReport.inserted).toBe(1);
    expect(reorgReport.replacements).toBe(1);
    expect(reorgReport.repairedPredictions).toBe(1);

    const oldRow = await pool.query(
      "SELECT canonical FROM indexer_events WHERE tx_hash = 'tx-fork-a'",
    );
    expect(oldRow.rows[0].canonical).toBe(false);

    const newRow = await pool.query(
      "SELECT canonical FROM indexer_events WHERE tx_hash = 'tx-fork-b'",
    );
    expect(newRow.rows[0].canonical).toBe(true);

    const reorgRows = await pool.query(
      "SELECT old_tx_hash, new_tx_hash, repaired_predictions FROM indexer_reorgs WHERE ledger = 400",
    );
    expect(reorgRows.rows).toHaveLength(1);
    expect(reorgRows.rows[0].old_tx_hash).toBe("tx-fork-a");
    expect(reorgRows.rows[0].new_tx_hash).toBe("tx-fork-b");
    expect(reorgRows.rows[0].repaired_predictions).toBe(1);

    const pred = await pool.query(
      "SELECT status, result FROM predictions WHERE tx_hash = 'tx-fork-a'",
    );
    expect(pred.rows[0].status).toBe("pending");
    expect(pred.rows[0].result).toBeNull();
  });

  it("Scenario 5: Failure injected after canonical flip - transaction rolled back, old row remains canonical, prediction unchanged", async () => {
    const userId = await seedUser("GA5555555555555555555555555555555555555555555555555555555555");
    const marketId = "market-rollback";
    await seedMarket(marketId);
    await seedPrediction("tx-orig", marketId, userId, "confirmed");

    const eventId = formatEventId(500, 1, 0, 0);
    await service.persistEventsWithRecovery([
      { id: eventId, ledger: 500, txHash: "tx-orig", marketId },
    ]);

    // Create a temporary trigger or failing constraint to inject failure during prediction update or insert
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_indexer_reorgs() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure during reorg insert';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trigger_fail_reorg
      BEFORE INSERT ON indexer_reorgs
      FOR EACH ROW EXECUTE FUNCTION fail_indexer_reorgs();
    `);

    try {
      await expect(
        service.persistEventsWithRecovery([
          { id: eventId, ledger: 500, txHash: "tx-competing", marketId },
        ]),
      ).rejects.toThrow("injected failure during reorg insert");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS trigger_fail_reorg ON indexer_reorgs");
      await pool.query("DROP FUNCTION IF EXISTS fail_indexer_reorgs");
    }

    // Verify rollback: old row is STILL canonical, prediction is STILL confirmed
    const origEvent = await pool.query(
      "SELECT canonical FROM indexer_events WHERE tx_hash = 'tx-orig'",
    );
    expect(origEvent.rows[0].canonical).toBe(true);

    const competingEvent = await pool.query(
      "SELECT * FROM indexer_events WHERE tx_hash = 'tx-competing'",
    );
    expect(competingEvent.rows).toHaveLength(0);

    const reorgRows = await pool.query(
      "SELECT * FROM indexer_reorgs WHERE ledger = 500",
    );
    expect(reorgRows.rows).toHaveLength(0);

    const pred = await pool.query(
      "SELECT status FROM predictions WHERE tx_hash = 'tx-orig'",
    );
    expect(pred.rows[0].status).toBe("confirmed");
  });

  it("Scenario 6: Malformed event id (no TOID prefix) - event rejected with warning, batch continues", async () => {
    const validId = formatEventId(600, 1, 0, 0);
    const report = await service.persistEventsWithRecovery([
      { id: "invalid-toid", ledger: 600, txHash: "tx-malformed" },
      { id: validId, ledger: 600, txHash: "tx-valid" },
    ]);

    expect(report.inserted).toBe(1);

    const events = await pool.query(
      "SELECT tx_hash FROM indexer_events WHERE ledger = 600",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].tx_hash).toBe("tx-valid");
  });

  it("Scenario 7: Multiple events in one operation (event index 0, 1, 2) - three distinct rows", async () => {
    const id0 = formatEventId(700, 1, 0, 0);
    const id1 = formatEventId(700, 1, 0, 1);
    const id2 = formatEventId(700, 1, 0, 2);

    const report = await service.persistEventsWithRecovery([
      { id: id0, ledger: 700, txHash: "tx-multi-event", opIndex: 0 },
      { id: id1, ledger: 700, txHash: "tx-multi-event", opIndex: 0 },
      { id: id2, ledger: 700, txHash: "tx-multi-event", opIndex: 0 },
    ]);

    expect(report.inserted).toBe(3);

    const rows = await pool.query(
      "SELECT event_index FROM indexer_events WHERE ledger = 700 AND tx_hash = 'tx-multi-event' ORDER BY event_index",
    );
    expect(rows.rows.map((r) => r.event_index)).toEqual([0, 1, 2]);
  });
});
