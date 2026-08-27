import { IndexerService } from "../src/services/indexerService";

const query = jest.fn();

jest.mock("../src/db/client", () => ({
  getPool: () => ({ query }),
}));

describe("IndexerService durable event recovery", () => {
  let service: IndexerService;

  beforeEach(() => {
    query.mockReset();
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

  it("persists a new canonical event with a safe fallback event type", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 });
    await expect(service.persistEventsWithRecovery([{ ledger: 10, txHash: "tx-10", opIndex: 2, payload: { amount: "5" } }])).resolves.toMatchObject({ inserted: 1, replacements: 0 });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("ON CONFLICT (ledger, tx_hash, op_index) DO NOTHING"),
      [10, "tx-10", 2, "unknown", JSON.stringify({ amount: "5" })],
    );
  });

  it("does not count exact redelivery as a new event", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 0 });
    const report = await service.persistEventsWithRecovery([{ ledger: 10, txHash: "tx-10", opIndex: 2, eventType: "prediction" }]);
    expect(report).toEqual({ inserted: 0, replacements: 0, repairedPredictions: 0 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("marks the stale event non-canonical and repairs derived prediction state", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ tx_hash: "old-tx" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const report = await service.persistEventsWithRecovery([{ ledger: 99, txHash: "new-tx", opIndex: 0, eventType: "settled", payload: { outcome: "yes" } }]);

    expect(report).toEqual({ inserted: 1, replacements: 1, repairedPredictions: 3 });
    expect(query.mock.calls[1][0]).toContain("SET canonical = FALSE");
    expect(query.mock.calls[2][0]).toContain("INSERT INTO indexer_reorgs");
    expect(query.mock.calls[3][0]).toContain("UPDATE predictions SET status = 'pending'");
    expect(query.mock.calls[3][1]).toEqual(["old-tx"]);
  });

  it("deduplicates repeated events before performing conflict checks", async () => {
    query.mockResolvedValue({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 });
    const report = await service.persistEventsWithRecovery([
      { ledger: 7, txHash: "tx", opIndex: 1, eventType: "a" },
      { ledger: 7, txHash: "tx", opIndex: 1, eventType: "a" },
    ]);
    expect(report.inserted).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct operations at one ledger independent", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 });
    const report = await service.persistEventsWithRecovery([
      { ledger: 12, txHash: "tx", opIndex: 0, eventType: "market" },
      { ledger: 12, txHash: "tx", opIndex: 1, eventType: "prediction" },
    ]);
    expect(report).toMatchObject({ inserted: 2, replacements: 0 });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("limits replay to the configured chunk size and advances after all chunks", async () => {
    const rpc = {
      getLatestLedger: jest.fn(),
      getEvents: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };
    service = new IndexerService(rpc);
    query.mockResolvedValueOnce({ rowCount: 1 });

    await service.backfillRange(1000, 1501);
    expect(rpc.getEvents).toHaveBeenCalledWith(900, 1399);
    expect(rpc.getEvents).toHaveBeenCalledWith(1400, 1501);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO indexer_cursor"), [1, 1501]);
  });

  it("does not rewind below the configured start ledger", async () => {
    const rpc = { getLatestLedger: jest.fn(), getEvents: jest.fn().mockResolvedValue([]) };
    service = new IndexerService(rpc);
    query.mockResolvedValueOnce({ rowCount: 1 });
    await service.backfillRange(1, 1);
    expect(rpc.getEvents).toHaveBeenCalledWith(0, 1);
  });

  it("returns no replay work for an inverted range", async () => {
    const rpc = { getLatestLedger: jest.fn(), getEvents: jest.fn() };
    service = new IndexerService(rpc);
    await service.backfillRange(20, 19);
    expect(rpc.getEvents).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("preserves checkpoint monotonicity through the SQL upsert", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await service.advanceCursor(500);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("GREATEST(indexer_cursor.last_ledger"), [1, 500]);
  });
});
