const poolQuery = jest.fn();

jest.mock("../src/db/client", () => ({
  getPool: () => ({ query: poolQuery }),
}));

import {
  groupConsecutiveLedgers,
  IndexerService,
  mergeGapRanges,
  SorobanRpcClient,
} from "../src/services/indexerService";
import { scanOnce } from "../src/workers/indexerGapScan";
import { indexerGapDetectedTotal, resetMetrics } from "../src/metrics/registry";

async function getCounterValue(counter: any, labels: Record<string, string | number>): Promise<number> {
  const metric = await counter.get();
  const found = metric.values?.find((val: any) => {
    return Object.entries(labels).every(([k, v]) => String(val.labels[k]) === String(v));
  });
  return found ? found.value : 0;
}

describe("groupConsecutiveLedgers", () => {
  it("groups consecutive ledgers into ranges", () => {
    expect(groupConsecutiveLedgers([102, 103, 105, 106, 107])).toEqual([
      { from: 102, to: 103 },
      { from: 105, to: 107 },
    ]);
  });

  it("returns empty array for no ledgers", () => {
    expect(groupConsecutiveLedgers([])).toEqual([]);
  });
});

describe("mergeGapRanges", () => {
  it("merges overlapping and adjacent ranges", () => {
    expect(
      mergeGapRanges([
        { from: 100, to: 102 },
        { from: 103, to: 105 },
        { from: 110, to: 111 },
      ]),
    ).toEqual([
      { from: 100, to: 105 },
      { from: 110, to: 111 },
    ]);
  });
});

describe("IndexerService.backfillRange", () => {
  const fetchedRanges: Array<{ start: number; end: number }> = [];

  const rpcClient: SorobanRpcClient = {
    async getLatestLedger() {
      return 200;
    },
    async getEvents(startLedger, endLedger) {
      fetchedRanges.push({ start: startLedger, end: endLedger });
      return [
        {
          ledger: startLedger,
          txHash: `tx-${startLedger}`,
          opIndex: 0,
          eventType: "contract",
        },
      ];
    },
  };

  beforeEach(() => {
    fetchedRanges.length = 0;
    poolQuery.mockImplementation(async (query: string, _params?: unknown[]) => {
      if (query.includes("INSERT INTO indexer_events")) {
        return { rowCount: 1, rows: [{ id: "1" }] };
      }
      if (query.includes("INSERT INTO indexer_cursor")) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    });
  });

  it("applies INDEXER_REWIND_LEDGERS when backfilling", async () => {
    const service = new IndexerService(rpcClient);

    await service.backfillRange(150, 160);

    expect(fetchedRanges[0]?.start).toBe(50);
    expect(fetchedRanges[fetchedRanges.length - 1]?.end).toBe(160);
  });

  it("dedupes events via ON CONFLICT DO NOTHING insert path", async () => {
    const service = new IndexerService(rpcClient);

    await service.persistEvents([
      { ledger: 10, txHash: "abc", opIndex: 0 },
      { ledger: 10, txHash: "abc", opIndex: 0 },
    ]);

    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (ledger, tx_hash, op_index) DO NOTHING"),
      expect.any(Array),
    );
  });

  it("chunks large backfills using INDEXER_BACKFILL_CHUNK_SIZE", async () => {
    const service = new IndexerService(rpcClient);

    await service.backfillRange(1, 2500);

    expect(fetchedRanges.length).toBeGreaterThan(1);
    expect(fetchedRanges[0]?.start).toBe(0);
    expect(fetchedRanges[fetchedRanges.length - 1]?.end).toBe(2500);
  });
});

describe("IndexerService.detectGaps", () => {
  beforeEach(() => {
    poolQuery.mockImplementation(async (query: string) => {
      if (query.includes("generate_series")) {
        return { rows: [{ missing_ledger: 102 }] };
      }
      if (query.includes("MAX(ledger)")) {
        return { rows: [{ max_ledger: 104 }] };
      }
      return { rows: [] };
    });
  });

  it("returns inner gap ranges from the ledger_series scan", async () => {
    const service = new IndexerService({
      getLatestLedger: async () => 104,
      getEvents: async () => [],
    });

    const gaps = await service.detectGaps(100, 104, 104);

    expect(gaps).toEqual([{ from: 102, to: 102 }]);
  });
});

describe("scanOnce gap healing", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("detects a synthetic gap and triggers one backfill for the range", async () => {
    const backfillCalls: Array<{ from: number; to: number }> = [];

    const service = {
      getCursor: jest.fn(async () => 104),
      getChainTip: jest.fn(async () => 104),
      detectGaps: jest.fn(async () => [{ from: 102, to: 102 }]),
      backfillRange: jest.fn(async (from: number, to: number) => {
        backfillCalls.push({ from, to });
      }),
    } as unknown as IndexerService;

    const result = await scanOnce(service);

    expect(result.gaps).toEqual([{ from: 102, to: 102 }]);
    expect(backfillCalls).toEqual([{ from: 102, to: 102 }]);
    expect(await getCounterValue(indexerGapDetectedTotal, { from: 102, to: 102 })).toBe(1);
  });

  it("increments metric once per detected gap range", async () => {
    const service = {
      getCursor: jest.fn(async () => 200),
      getChainTip: jest.fn(async () => 210),
      detectGaps: jest.fn(async () => [
        { from: 105, to: 107 },
        { from: 109, to: 109 },
      ]),
      backfillRange: jest.fn(async () => undefined),
    } as unknown as IndexerService;

    await scanOnce(service);

    expect(await getCounterValue(indexerGapDetectedTotal, { from: 105, to: 107 })).toBe(1);
    expect(await getCounterValue(indexerGapDetectedTotal, { from: 109, to: 109 })).toBe(1);
  });
});
