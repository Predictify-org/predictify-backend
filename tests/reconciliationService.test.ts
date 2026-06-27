import {
  createReconciliationService,
  diffMarketPositions,
  ReconciliationNotFoundError,
  type ReconciliationSidePosition,
} from "../src/services/reconciliationService";

describe("diffMarketPositions", () => {
  it("classifies matches, mismatches, and missing keys", () => {
    const dbPositions: ReconciliationSidePosition[] = [
      { stellarAddress: "A", outcome: "yes", amount: "100" },
      { stellarAddress: "B", outcome: "no", amount: "20" },
      { stellarAddress: "C", outcome: "yes", amount: "30" },
    ];

    const onChainPositions: ReconciliationSidePosition[] = [
      { stellarAddress: "A", outcome: "yes", amount: "100" },
      { stellarAddress: "B", outcome: "no", amount: "15" },
      { stellarAddress: "D", outcome: "yes", amount: "5" },
    ];

    const result = diffMarketPositions(dbPositions, onChainPositions);

    expect(result.summary).toEqual({
      totalKeys: 4,
      matches: 1,
      mismatches: 1,
      missingOnChain: 1,
      missingInDb: 1,
    });
    expect(result.diffs).toEqual([
      {
        key: { stellarAddress: "A", outcome: "yes" },
        dbAmount: "100",
        onChainAmount: "100",
        difference: "0",
        status: "match",
      },
      {
        key: { stellarAddress: "B", outcome: "no" },
        dbAmount: "20",
        onChainAmount: "15",
        difference: "5",
        status: "mismatch",
      },
      {
        key: { stellarAddress: "C", outcome: "yes" },
        dbAmount: "30",
        onChainAmount: null,
        difference: null,
        status: "missing_on_chain",
      },
      {
        key: { stellarAddress: "D", outcome: "yes" },
        dbAmount: "0",
        onChainAmount: "5",
        difference: null,
        status: "missing_in_db",
      },
    ]);
  });
});

describe("createReconciliationService", () => {
  it("returns a partial result when on-chain data is unavailable and audits the request", async () => {
    const marketExists = jest.fn().mockResolvedValue(true);
    const getDbPositions = jest.fn().mockResolvedValue([
      { stellarAddress: "A", outcome: "yes", amount: "100" },
      { stellarAddress: "A", outcome: "no", amount: "25" },
    ]);
    const getOnChainPositions = jest.fn().mockResolvedValue({
      positions: [],
      source: "soroban-rpc",
      available: false,
      unavailableReason: "adapter not configured",
    });
    const writeAudit = jest.fn().mockResolvedValue("corr-1");

    const service = createReconciliationService({
      marketExists,
      getDbPositions,
      getOnChainPositions,
      writeAudit,
    });

    const result = await service.reconcileMarket({
      marketId: "market-1",
      adminAddress: "GADMIN",
      ip: "127.0.0.1",
      correlationId: "corr-1",
    });

    expect(result.status).toBe("partial");
    expect(result.dbSnapshot.totalAmount).toBe("125");
    expect(result.onChainSnapshot.available).toBe(false);
    expect(result.onChainSnapshot.unavailableReason).toBe("adapter not configured");
    expect(result.summary).toEqual({
      totalKeys: 2,
      matches: 0,
      mismatches: 0,
      missingOnChain: 2,
      missingInDb: 0,
    });
    expect(writeAudit).toHaveBeenCalledWith({
      action: "admin.reconciliation.market.inspect",
      walletAddress: "GADMIN",
      ip: "127.0.0.1",
      correlationId: "corr-1",
    });
  });

  it("throws not_found when the market does not exist", async () => {
    const service = createReconciliationService({
      marketExists: jest.fn().mockResolvedValue(false),
      getDbPositions: jest.fn(),
      getOnChainPositions: jest.fn(),
      writeAudit: jest.fn(),
    });

    await expect(
      service.reconcileMarket({
        marketId: "missing",
        adminAddress: "GADMIN",
        ip: "127.0.0.1",
        correlationId: "corr-2",
      }),
    ).rejects.toBeInstanceOf(ReconciliationNotFoundError);
  });
});
