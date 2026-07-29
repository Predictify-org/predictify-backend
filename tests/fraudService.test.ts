import {
  UnionFind,
  buildGraph,
  clusterize,
  makeClusterKey,
  runFraudScan,
  type FraudRepo,
  type PredictionRow,
  type FlagWriteInput,
  PATTERN_BUCKET_MS,
} from "../src/services/fraudService";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

let _rowCounter = 0;
function mkRow(overrides: Partial<PredictionRow> = {}): PredictionRow {
  _rowCounter += 1;
  // Defaults are picked so that, in the absence of overrides, no two rows
  // share a market/outcome/amount/time bucket — keeps each test focused on
  // the specific edge type it is asserting.
  return {
    predictionId: overrides.predictionId ?? `p-${_rowCounter}`,
    userId: overrides.userId ?? `u-${overrides.stellarAddress ?? `x${_rowCounter}`}`,
    stellarAddress: overrides.stellarAddress ?? `GAAA${_rowCounter}`,
    marketId: overrides.marketId ?? `m-${_rowCounter}`,
    outcome: overrides.outcome ?? "yes",
    amount: overrides.amount ?? `${100 + _rowCounter}`,
    txHash: overrides.txHash ?? "",
    fundingSource: overrides.fundingSource ?? null,
    createdAt:
      overrides.createdAt ??
      new Date(2026, 5, 1, 12, 0, _rowCounter * 60, 0),
  };
}

class FakeRepo implements FraudRepo {
  rows: PredictionRow[] = [];
  written: FlagWriteInput[] = [];
  listed: ReturnType<FraudRepo["listFlags"]> extends Promise<infer R>
    ? R
    : never = [];

  async loadRecentPredictions(): Promise<PredictionRow[]> {
    return this.rows;
  }
  async upsertFlags(rows: FlagWriteInput[]): Promise<number> {
    this.written.push(...rows);
    return rows.length;
  }
  async listFlags(): Promise<any[]> {
    return this.listed as any[];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// UnionFind
// ────────────────────────────────────────────────────────────────────────────

describe("UnionFind", () => {
  it("treats unseen nodes as their own root", () => {
    const uf = new UnionFind<string>();
    expect(uf.find("a")).toBe("a");
  });

  it("unions two singletons and reports a single component", () => {
    const uf = new UnionFind<string>();
    expect(uf.union("a", "b")).toBe(true);
    expect(uf.find("a")).toBe(uf.find("b"));
    expect(uf.union("a", "b")).toBe(false); // already merged
  });

  it("collapses a transitive chain into one component", () => {
    const uf = new UnionFind<string>();
    uf.union("a", "b");
    uf.union("b", "c");
    uf.union("c", "d");
    const comps = uf.components();
    expect(comps.size).toBe(1);
    expect([...comps.values()][0].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps disjoint sets disjoint", () => {
    const uf = new UnionFind<string>();
    uf.union("a", "b");
    uf.union("c", "d");
    expect(uf.components().size).toBe(2);
  });

  it("path-compresses on find without changing semantics", () => {
    const uf = new UnionFind<string>();
    for (const n of ["a", "b", "c", "d", "e"]) uf.add(n);
    uf.union("a", "b");
    uf.union("b", "c");
    uf.union("c", "d");
    uf.union("d", "e");
    // Call find many times — must remain stable.
    const root = uf.find("a");
    for (const n of ["a", "b", "c", "d", "e"]) {
      expect(uf.find(n)).toBe(root);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// makeClusterKey
// ────────────────────────────────────────────────────────────────────────────

describe("makeClusterKey", () => {
  it("is order-independent", () => {
    expect(makeClusterKey(["GBBB", "GAAA"])).toBe(
      makeClusterKey(["GAAA", "GBBB"]),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildGraph
// ────────────────────────────────────────────────────────────────────────────

describe("buildGraph", () => {
  it("returns an empty graph for empty input", () => {
    const g = buildGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.edges).toEqual([]);
  });

  it("ignores rows with no stellar address", () => {
    const g = buildGraph([mkRow({ stellarAddress: "" })]);
    expect(g.nodes.size).toBe(0);
  });

  it("creates a SHARED_FUNDING_SOURCE edge between two addresses funded by the same wallet", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GB", fundingSource: "GF" }),
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].reason).toBe("SHARED_FUNDING_SOURCE");
    expect(g.edges[0].detail).toBe("GF");
    expect([g.edges[0].a, g.edges[0].b].sort()).toEqual(["GA", "GB"]);
  });

  it("does not create funding edges when funder is null", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: null }),
      mkRow({ stellarAddress: "GB", fundingSource: null }),
    ]);
    expect(g.edges).toHaveLength(0);
  });

  it("creates SHARED_TX_HASH edges", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", txHash: "tx-1" }),
      mkRow({ stellarAddress: "GB", txHash: "tx-1" }),
    ]);
    expect(g.edges.some((e) => e.reason === "SHARED_TX_HASH")).toBe(true);
  });

  it("does NOT create tx-hash edges for empty tx strings", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", txHash: "" }),
      mkRow({ stellarAddress: "GB", txHash: "" }),
    ]);
    expect(g.edges.some((e) => e.reason === "SHARED_TX_HASH")).toBe(false);
  });

  it("buckets near-simultaneous identical bets as REPEATED_PATTERN", () => {
    const base = new Date("2026-06-01T12:00:00Z").getTime();
    const g = buildGraph([
      mkRow({
        stellarAddress: "GA",
        marketId: "m",
        outcome: "yes",
        amount: "10",
        createdAt: new Date(base),
      }),
      mkRow({
        stellarAddress: "GB",
        marketId: "m",
        outcome: "yes",
        amount: "10",
        createdAt: new Date(base + 1000), // same bucket
      }),
    ]);
    expect(g.edges.some((e) => e.reason === "REPEATED_PATTERN")).toBe(true);
  });

  it("does NOT bucket identical bets that fall into different time buckets", () => {
    const base = new Date("2026-06-01T12:00:00Z").getTime();
    const g = buildGraph([
      mkRow({
        stellarAddress: "GA",
        marketId: "m",
        outcome: "yes",
        amount: "10",
        createdAt: new Date(base),
      }),
      mkRow({
        stellarAddress: "GB",
        marketId: "m",
        outcome: "yes",
        amount: "10",
        createdAt: new Date(base + PATTERN_BUCKET_MS * 3),
      }),
    ]);
    expect(g.edges.some((e) => e.reason === "REPEATED_PATTERN")).toBe(false);
  });

  it("never creates self-loops", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
    ]);
    expect(g.edges).toHaveLength(0);
  });

  it("dedupes identical edges from multiple prediction pairs", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GB", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GB", fundingSource: "GF" }),
    ]);
    const funderEdges = g.edges.filter(
      (e) => e.reason === "SHARED_FUNDING_SOURCE",
    );
    expect(funderEdges).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// clusterize
// ────────────────────────────────────────────────────────────────────────────

describe("clusterize", () => {
  it("ignores singleton components", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
    ]);
    expect(clusterize(g)).toEqual([]);
  });

  it("groups addresses linked transitively through different reasons", () => {
    // GA ↔ GB via funder, GB ↔ GC via tx hash → cluster {GA, GB, GC}
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GB", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GB", txHash: "tx-1" }),
      mkRow({ stellarAddress: "GC", txHash: "tx-1" }),
    ]);
    const clusters = clusterize(g);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual(["GA", "GB", "GC"]);
    expect(clusters[0].score).toBeGreaterThan(0);
    expect(clusters[0].key).toBe("GA|GB|GC");
  });

  it("returns multiple clusters when address groups are disjoint", () => {
    const g = buildGraph([
      mkRow({ stellarAddress: "GA", fundingSource: "GF1" }),
      mkRow({ stellarAddress: "GB", fundingSource: "GF1" }),
      mkRow({ stellarAddress: "GC", fundingSource: "GF2" }),
      mkRow({ stellarAddress: "GD", fundingSource: "GF2" }),
    ]);
    const clusters = clusterize(g);
    expect(clusters).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runFraudScan (orchestration)
// ────────────────────────────────────────────────────────────────────────────

describe("runFraudScan", () => {
  it("validates lookbackMs", async () => {
    const repo = new FakeRepo();
    await expect(
      runFraudScan(repo, { lookbackMs: -1 }),
    ).rejects.toThrow(/lookbackMs/);
  });

  it("validates maxPredictions", async () => {
    const repo = new FakeRepo();
    await expect(
      runFraudScan(repo, { maxPredictions: 0 }),
    ).rejects.toThrow(/maxPredictions/);
  });

  it("returns zero counts when there is no data", async () => {
    const repo = new FakeRepo();
    const res = await runFraudScan(repo, { correlationId: "cid-1" });
    expect(res).toMatchObject({
      scanned: 0,
      edges: 0,
      clusters: 0,
      flagsWritten: 0,
      correlationId: "cid-1",
    });
    expect(repo.written).toEqual([]);
  });

  it("persists one flag per address in each cluster, idempotently in shape", async () => {
    const repo = new FakeRepo();
    repo.rows = [
      mkRow({
        stellarAddress: "GA",
        userId: "u-a",
        fundingSource: "GF",
      }),
      mkRow({
        stellarAddress: "GB",
        userId: "u-b",
        fundingSource: "GF",
      }),
    ];

    const res = await runFraudScan(repo, { correlationId: "cid-2" });

    expect(res.scanned).toBe(2);
    expect(res.clusters).toBe(1);
    expect(res.flagsWritten).toBe(2);

    expect(repo.written).toHaveLength(2);
    const addrs = repo.written.map((w) => w.stellarAddress).sort();
    expect(addrs).toEqual(["GA", "GB"]);

    for (const w of repo.written) {
      expect(w.clusterKey).toBe("GA|GB");
      expect(w.reason).toBe("SHARED_FUNDING_SOURCE");
      expect(w.correlationId).toBe("cid-2");
      expect(w.score).toBeGreaterThan(0);
      const ev = w.evidence as Record<string, unknown>;
      expect(ev.clusterSize).toBe(2);
      expect(ev.members).toEqual(["GA", "GB"]);
      expect(Array.isArray(ev.edges)).toBe(true);
    }
  });

  it("skips an address gracefully when its userId cannot be resolved", async () => {
    const repo = new FakeRepo();
    // Inject a row with empty userId — should not crash, just skip
    repo.rows = [
      mkRow({ stellarAddress: "GA", userId: "u-a", fundingSource: "GF" }),
      mkRow({ stellarAddress: "GB", userId: "", fundingSource: "GF" }),
    ];
    const res = await runFraudScan(repo);
    // Cluster forms (size 2) but only GA can be persisted
    expect(res.clusters).toBe(1);
    expect(res.flagsWritten).toBe(1);
    expect(repo.written[0].stellarAddress).toBe("GA");
  });

  it("uses the supplied clock to compute the since cutoff", async () => {
    const repo = new FakeRepo();
    const loadSpy = jest.spyOn(repo, "loadRecentPredictions");
    const fixedNow = new Date("2026-06-15T00:00:00Z");
    await runFraudScan(repo, {
      now: () => fixedNow,
      lookbackMs: 60_000,
    });
    expect(loadSpy).toHaveBeenCalledWith({
      since: new Date(fixedNow.getTime() - 60_000),
      limit: expect.any(Number),
    });
  });
});
