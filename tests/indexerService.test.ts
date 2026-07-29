import { IndexerService, INDEXER_CURSOR_ID } from "../src/services/indexerService";
import { env } from "../src/config/env";

const mockPoolQuery = jest.fn();

jest.mock("../src/db/client", () => ({
  getPool: () => ({
    query: mockPoolQuery,
  }),
}));

const mockRpcClient = {
  getLatestLedger: jest.fn(),
  getEvents: jest.fn(),
};

describe("IndexerService", () => {
  let service: IndexerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IndexerService(mockRpcClient);
  });

  describe("getCursor", () => {
    it("returns start ledger from env when cursor table is empty", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const cursor = await service.getCursor();
      expect(cursor).toBe(env.INDEXER_START_LEDGER);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        "SELECT last_ledger FROM indexer_cursor WHERE id = $1",
        [INDEXER_CURSOR_ID]
      );
    });

    it("returns last_ledger from database when present", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ last_ledger: 500 }] });
      const cursor = await service.getCursor();
      expect(cursor).toBe(500);
    });
  });

  describe("getChainTip", () => {
    it("returns sequence from RPC getLatestLedger", async () => {
      mockRpcClient.getLatestLedger.mockResolvedValueOnce(800);
      const tip = await service.getChainTip();
      expect(tip).toBe(800);
      expect(mockRpcClient.getLatestLedger).toHaveBeenCalled();
    });
  });

  describe("pollOnce", () => {
    it("skips fetching and returns cursor if startLedger is ahead of tip", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ last_ledger: 500 }] });
      mockRpcClient.getLatestLedger.mockResolvedValueOnce(-999999);

      const result = await service.pollOnce();
      expect(result).toBe(500);
      expect(mockRpcClient.getEvents).not.toHaveBeenCalled();
    });

    it("polls, persists events, advances cursor and returns tip sequence", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ last_ledger: 500 }] });
      mockRpcClient.getLatestLedger.mockResolvedValueOnce(550);
      mockRpcClient.getEvents.mockResolvedValueOnce([
        { ledger: 501, txHash: "tx1", opIndex: 0, eventType: "contract", payload: { val: 1 } }
      ]);
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.pollOnce();
      expect(result).toBe(550);
    });
  });
});
