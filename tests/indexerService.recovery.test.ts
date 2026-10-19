import {
  IndexerService,
  extractMarketId,
  formatEventId,
  createSorobanRpcClient,
} from "../src/services/indexerService";
import { rpc } from "@stellar/stellar-sdk";

const query = jest.fn();
const release = jest.fn();
const client = { query, release };
const pool = {
  query,
  connect: jest.fn().mockResolvedValue(client),
};

jest.mock("../src/db/client", () => ({
  getPool: () => pool,
}));

jest.mock("@stellar/stellar-sdk", () => {
  return {
    rpc: {
      Server: jest.fn(),
    },
  };
});

describe("IndexerService durable event recovery", () => {
  let service: IndexerService;

  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    pool.connect.mockReset().mockResolvedValue(client);

    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT id, tx_hash FROM indexer_events")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO indexer_events")) {
        return { rowCount: 1, rows: [{ id: "ev-1" }] };
      }
      if (sql.includes("UPDATE indexer_events")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE predictions")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO indexer_reorgs")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    service = new IndexerService({
      getLatestLedger: jest.fn(),
      getEvents: jest.fn(),
    });
  });

  it("does not touch the database for an empty RPC batch", async () => {
    await expect(service.persistEventsWithRecovery([])).resolves.toEqual({
      inserted: 0,
      replacements: 0,
      repairedPredictions: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("Scenario 1: persists a new canonical event binding all columns and populating market_id", async () => {
    await expect(
      service.persistEventsWithRecovery([
        {
          ledger: 10,
          txHash: "tx-10",
          opIndex: 2,
          txApplicationOrder: 1,
          eventIndex: 0,
          marketId: "market-xyz",
          payload: { amount: "5" },
        },
      ]),
    ).resolves.toMatchObject({ inserted: 1, replacements: 0 });

    const insertCall = query.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("INSERT INTO indexer_events"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain(
      "ON CONFLICT (ledger, tx_hash, op_index, event_index) DO NOTHING",
    );
    expect(insertCall[1]).toEqual([
      10,
      "tx-10",
      1,
      2,
      0,
      "unknown",
      "market-xyz",
      JSON.stringify({ amount: "5" }),
      true,
    ]);
  });

  it("Scenario 2: two different txs in same ledger with suffix 0000000000 produce two canonical rows without reorg", async () => {
    const eventIdTx1 = formatEventId(100, 1, 0, 0); // suffix 0000000000, txAppOrder 1
    const eventIdTx2 = formatEventId(100, 2, 0, 0); // suffix 0000000000, txAppOrder 2

    const report = await service.persistEventsWithRecovery([
      { id: eventIdTx1, ledger: 100, txHash: "tx-first", opIndex: 0 },
      { id: eventIdTx2, ledger: 100, txHash: "tx-second", opIndex: 0 },
    ]);

    expect(report).toEqual({
      inserted: 2,
      replacements: 0,
      repairedPredictions: 0,
    });

    const reorgInserts = query.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes("INSERT INTO indexer_reorgs"),
    );
    expect(reorgInserts).toHaveLength(0);
  });

  it("Scenario 3: does not count exact redelivery as a new event and creates no reorg", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT id, tx_hash FROM indexer_events")) {
        return { rows: [{ id: "existing-1", tx_hash: "tx-10" }] };
      }
      if (sql.includes("INSERT INTO indexer_events")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const report = await service.persistEventsWithRecovery([
      { ledger: 10, txHash: "tx-10", opIndex: 2, eventType: "prediction" },
    ]);
    expect(report).toEqual({ inserted: 0, replacements: 0, repairedPredictions: 0 });
  });

  it("Scenario 4: marks the stale event non-canonical, inserts reorg row, and repairs predictions on real replacement", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT id, tx_hash FROM indexer_events")) {
        return { rows: [{ id: "row-old", tx_hash: "old-tx" }] };
      }
      if (sql.includes("UPDATE indexer_events SET canonical = FALSE")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE predictions SET status = 'pending'")) {
        return { rowCount: 3, rows: [] };
      }
      if (sql.includes("INSERT INTO indexer_reorgs")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO indexer_events")) {
        return { rowCount: 1, rows: [{ id: "row-new" }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const report = await service.persistEventsWithRecovery([
      {
        ledger: 99,
        txHash: "new-tx",
        txApplicationOrder: 1,
        opIndex: 0,
        eventIndex: 0,
        eventType: "settled",
        payload: { outcome: "yes" },
      },
    ]);

    expect(report).toEqual({ inserted: 1, replacements: 1, repairedPredictions: 3 });

    const flipCall = query.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("SET canonical = FALSE"),
    );
    expect(flipCall).toBeDefined();
    expect(flipCall[1]).toEqual(["row-old"]);

    const reorgCall = query.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("INSERT INTO indexer_reorgs"),
    );
    expect(reorgCall).toBeDefined();
    expect(reorgCall[1]).toEqual([99, 1, 0, 0, "old-tx", "new-tx", 3]);

    const repairCall = query.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("UPDATE predictions SET status = 'pending'"),
    );
    expect(repairCall).toBeDefined();
    expect(repairCall[1]).toEqual(["old-tx"]);
  });

  it("Scenario 5: failure injected after canonical flip rolls back the transaction", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT id, tx_hash FROM indexer_events")) {
        return { rows: [{ id: "row-old", tx_hash: "old-tx" }] };
      }
      if (sql.includes("UPDATE indexer_events SET canonical = FALSE")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE predictions SET status = 'pending'")) {
        throw new Error("DB connection failure during prediction repair");
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(
      service.persistEventsWithRecovery([
        {
          ledger: 99,
          txHash: "new-tx",
          txApplicationOrder: 1,
          opIndex: 0,
          eventIndex: 0,
        },
      ]),
    ).rejects.toThrow("DB connection failure during prediction repair");

    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });

  it("Scenario 6: malformed event id is rejected with logged warning and batch continues", async () => {
    const report = await service.persistEventsWithRecovery([
      { id: "invalid-event-id", ledger: 5, txHash: "tx-bad", opIndex: 0 },
      { ledger: 5, txHash: "tx-good", opIndex: 1 },
    ]);

    expect(report.inserted).toBe(1);
    const insertCalls = query.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("INSERT INTO indexer_events"),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1][1]).toBe("tx-good");
  });

  it("Scenario 7: multiple events in one operation are inserted as distinct rows", async () => {
    const eventId0 = formatEventId(50, 1, 0, 0);
    const eventId1 = formatEventId(50, 1, 0, 1);
    const eventId2 = formatEventId(50, 1, 0, 2);

    const report = await service.persistEventsWithRecovery([
      { id: eventId0, ledger: 50, txHash: "tx-shared", opIndex: 0 },
      { id: eventId1, ledger: 50, txHash: "tx-shared", opIndex: 0 },
      { id: eventId2, ledger: 50, txHash: "tx-shared", opIndex: 0 },
    ]);

    expect(report.inserted).toBe(3);
    expect(report.replacements).toBe(0);
  });

  it("deduplicates repeated events before performing conflict checks", async () => {
    const report = await service.persistEventsWithRecovery([
      { ledger: 7, txHash: "tx", opIndex: 1, eventType: "a" },
      { ledger: 7, txHash: "tx", opIndex: 1, eventType: "a" },
    ]);
    expect(report.inserted).toBe(1);
    const selectCalls = query.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("SELECT id, tx_hash FROM indexer_events"),
    );
    expect(selectCalls).toHaveLength(1);
  });

  it("extractMarketId extracts marketId from payload if omitted at top level", () => {
    expect(
      extractMarketId({
        ledger: 1,
        txHash: "tx",
        opIndex: 0,
        payload: { marketId: "m-123" },
      }),
    ).toBe("m-123");
    expect(
      extractMarketId({
        ledger: 1,
        txHash: "tx",
        opIndex: 0,
        payload: { market_id: "m-456" },
      }),
    ).toBe("m-456");
    expect(
      extractMarketId({
        ledger: 1,
        txHash: "tx",
        opIndex: 0,
        marketId: "direct",
        payload: { marketId: "ignored" },
      }),
    ).toBe("direct");
    expect(
      extractMarketId({
        ledger: 1,
        txHash: "tx",
        opIndex: 0,
      }),
    ).toBeNull();
  });

  it("limits replay to the configured chunk size and advances after all chunks", async () => {
    const rpcMock = {
      getLatestLedger: jest.fn(),
      getEvents: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
    };
    service = new IndexerService(rpcMock);
    query.mockResolvedValueOnce({ rowCount: 1 });

    await service.backfillRange(1000, 1501);
    expect(rpcMock.getEvents).toHaveBeenCalledWith(900, 1399);
    expect(rpcMock.getEvents).toHaveBeenCalledWith(1400, 1501);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO indexer_cursor"),
      [1, 1501],
    );
  });

  it("does not rewind below the configured start ledger", async () => {
    const rpcMock = { getLatestLedger: jest.fn(), getEvents: jest.fn().mockResolvedValue([]) };
    service = new IndexerService(rpcMock);
    query.mockResolvedValueOnce({ rowCount: 1 });
    await service.backfillRange(1, 1);
    expect(rpcMock.getEvents).toHaveBeenCalledWith(0, 1);
  });

  it("returns no replay work for an inverted range", async () => {
    const rpcMock = { getLatestLedger: jest.fn(), getEvents: jest.fn() };
    service = new IndexerService(rpcMock);
    await service.backfillRange(20, 19);
    expect(rpcMock.getEvents).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("preserves checkpoint monotonicity through the SQL upsert", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await service.advanceCursor(500);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("GREATEST(indexer_cursor.last_ledger"),
      [1, 500],
    );
  });

  it("finds missing ledgers and max indexed ledger", async () => {
    query.mockResolvedValueOnce({ rows: [{ missing_ledger: 5 }, { missing_ledger: 6 }] });
    const missing = await service.findMissingLedgers(1, 10);
    expect(missing).toEqual([5, 6]);

    expect(await service.findMissingLedgers(10, 5)).toEqual([]);

    query.mockResolvedValueOnce({ rows: [{ max_ledger: 42 }] });
    const maxLedger = await service.getMaxIndexedLedger(1, 50);
    expect(maxLedger).toBe(42);

    query.mockResolvedValueOnce({ rows: [] });
    expect(await service.getMaxIndexedLedger(1, 50)).toBeNull();
  });

  it("getCursor returns start ledger if no cursor row exists", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const cursor = await service.getCursor();
    expect(cursor).toBeDefined();

    query.mockResolvedValueOnce({ rows: [{ last_ledger: 55 }] });
    expect(await service.getCursor()).toBe(55);
  });

  it("pollOnce coordinates getCursor, getChainTip, fetchEvents and advanceCursor", async () => {
    const rpcMock = {
      getLatestLedger: jest.fn().mockResolvedValue(100),
      getEvents: jest.fn().mockResolvedValue([]),
    };
    service = new IndexerService(rpcMock);
    query.mockResolvedValue({ rows: [{ last_ledger: 95 }] });

    const tip = await service.pollOnce();
    expect(tip).toBe(100);
    expect(rpcMock.getEvents).toHaveBeenCalled();

    // When cursor is already ahead of tip
    rpcMock.getLatestLedger.mockResolvedValue(50);
    query.mockResolvedValue({ rows: [{ last_ledger: 1000 }] });
    const sameCursor = await service.pollOnce();
    expect(sameCursor).toBe(1000);
  });

  it("createSorobanRpcClient pagination and event decoding", async () => {
    const getEventsMock = jest.fn();
    const getLatestLedgerMock = jest.fn().mockResolvedValue({ sequence: 500 });

    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getEvents: getEventsMock,
      getLatestLedger: getLatestLedgerMock,
    }));

    const clientRpc = createSorobanRpcClient();
    expect(await clientRpc.getLatestLedger()).toBe(500);

    const validId = formatEventId(10, 1, 0, 0);
    getEventsMock
      .mockResolvedValueOnce({
        events: [
          { id: validId, ledger: 10, txHash: "tx-1", type: "contract", value: { a: 1 }, pagingToken: "p1" },
          { id: "bad-id", ledger: 10, txHash: "tx-bad", type: "contract", value: null, pagingToken: "p2" },
          { id: formatEventId(20, 1, 0, 0), ledger: 20, txHash: "tx-over", type: "contract", value: null },
        ],
      });

    const events = await clientRpc.getEvents(10, 15);
    expect(events).toHaveLength(1);
    expect(events[0].txHash).toBe("tx-1");

    // Test loop termination when lastEvent.ledger >= endLedger
    getEventsMock.mockResolvedValueOnce({
      events: [
        { id: formatEventId(15, 1, 0, 0), ledger: 15, txHash: "tx-end", type: "contract", value: null },
      ],
    });
    const eventsEnd = await clientRpc.getEvents(10, 15);
    expect(eventsEnd).toHaveLength(1);

    // Test loop termination when pagingToken is absent
    getEventsMock.mockResolvedValueOnce({
      events: [
        { id: formatEventId(12, 1, 0, 0), ledger: 12, txHash: "tx-no-token", type: "contract", value: null },
      ],
    });
    const eventsNoToken = await clientRpc.getEvents(10, 15);
    expect(eventsNoToken).toHaveLength(1);

    // Test loop termination when response has 0 events
    getEventsMock.mockResolvedValueOnce({ events: [] });
    const eventsEmpty = await clientRpc.getEvents(10, 15);
    expect(eventsEmpty).toHaveLength(0);
  });

  it("covers parseEventOpIndex, mergeGapRanges empty, and all-malformed batch", async () => {
    const { parseEventOpIndex, mergeGapRanges } = await import("../src/services/indexerService");
    const validId = formatEventId(10, 1, 3, 0);
    expect(parseEventOpIndex(validId, 99)).toBe(3);
    expect(parseEventOpIndex("invalid-event-id", 99)).toBe(99);

    expect(mergeGapRanges([])).toEqual([]);

    const report = await service.persistEventsWithRecovery([
      { id: "malformed-1", ledger: 1, txHash: "bad", opIndex: 0 },
    ]);
    expect(report).toEqual({ inserted: 0, replacements: 0, repairedPredictions: 0 });

    expect(
      extractMarketId({
        ledger: 1,
        txHash: "tx",
        opIndex: 0,
        payload: "string-payload-not-object",
      }),
    ).toBeNull();
  });
});
