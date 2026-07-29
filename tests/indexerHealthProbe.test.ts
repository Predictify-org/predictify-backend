/**
 * indexerHealthProbe.test.ts
 *
 * Unit tests for the periodic indexer lag health probe.
 *
 * All tests are fully isolated: no database, no network, no real timers.
 * The IndexerService is replaced by a minimal stub that returns controlled
 * cursor/chainTip values.
 */

import { runIndexerHealthProbe } from "../src/jobs/indexerHealthProbe";
import { indexerLagLedgers } from "../src/metrics/registry";

// ── Stub service ──────────────────────────────────────────────────────────────

interface StubService {
  cursor: number;
  tip: number;
  getCursor(): Promise<number>;
  getChainTip(): Promise<number>;
}

function makeStub(cursor: number, tip: number): StubService {
  return {
    cursor,
    tip,
    getCursor: () => Promise.resolve(cursor),
    getChainTip: () => Promise.resolve(tip),
  };
}

// ── Gauge spy ─────────────────────────────────────────────────────────────────

let gaugeValue: number | undefined;

beforeEach(() => {
  gaugeValue = undefined;
  jest.spyOn(indexerLagLedgers, "set").mockImplementation((v: number) => {
    gaugeValue = v;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runIndexerHealthProbe — lag calculation", () => {
  it("sets gauge to 0 when indexer is at chain tip", async () => {
    await runIndexerHealthProbe(makeStub(1000, 1000), 200);
    expect(gaugeValue).toBe(0);
  });

  it("sets gauge to the correct positive lag", async () => {
    await runIndexerHealthProbe(makeStub(800, 1000), 200);
    expect(gaugeValue).toBe(200);
  });

  it("clamps negative lag to 0 (cursor ahead of tip edge case)", async () => {
    await runIndexerHealthProbe(makeStub(1050, 1000), 200);
    expect(gaugeValue).toBe(0);
  });
});

describe("runIndexerHealthProbe — threshold alerting", () => {
  it("does NOT warn when lag equals the threshold (boundary — exact match is ok)", async () => {
    const warnSpy = jest.spyOn(require("../src/config/logger").logger, "warn");
    await runIndexerHealthProbe(makeStub(800, 1000), 200); // lag = 200 = threshold
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns when lag exceeds the threshold by 1", async () => {
    const warnSpy = jest.spyOn(require("../src/config/logger").logger, "warn");
    await runIndexerHealthProbe(makeStub(799, 1000), 200); // lag = 201 > 200
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = warnSpy.mock.calls[0];
    expect(payload).toMatchObject({
      event: "indexer.lag_threshold_breached",
      lag: 201,
      cursor: 799,
      chainTip: 1000,
      threshold: 200,
    });
    expect(message).toContain("indexer lag exceeds threshold");
  });

  it("warns with correct values for a large lag", async () => {
    const warnSpy = jest.spyOn(require("../src/config/logger").logger, "warn");
    await runIndexerHealthProbe(makeStub(0, 5000), 200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0];
    expect(payload).toMatchObject({ lag: 5000, threshold: 200 });
  });

  it("does NOT warn when lag is well below the threshold", async () => {
    const warnSpy = jest.spyOn(require("../src/config/logger").logger, "warn");
    await runIndexerHealthProbe(makeStub(990, 1000), 200); // lag = 10
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("runIndexerHealthProbe — error handling", () => {
  it("swallows getCursor errors and logs them without throwing", async () => {
    const errorSpy = jest.spyOn(require("../src/config/logger").logger, "error");
    const brokenService = {
      getCursor: () => Promise.reject(new Error("DB unavailable")),
      getChainTip: () => Promise.resolve(1000),
    };

    await expect(runIndexerHealthProbe(brokenService, 200)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "indexer_health_probe_fetch_failed",
    );
    // Gauge must NOT be updated if we couldn't fetch
    expect(gaugeValue).toBeUndefined();
  });

  it("swallows getChainTip errors and logs them without throwing", async () => {
    const errorSpy = jest.spyOn(require("../src/config/logger").logger, "error");
    const brokenService = {
      getCursor: () => Promise.resolve(500),
      getChainTip: () => Promise.reject(new Error("RPC timeout")),
    };

    await expect(runIndexerHealthProbe(brokenService, 200)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(gaugeValue).toBeUndefined();
  });
});

describe("runIndexerHealthProbe — custom threshold", () => {
  it("respects a stricter threshold", async () => {
    const warnSpy = jest.spyOn(require("../src/config/logger").logger, "warn");
    // lag = 50, threshold = 10  → should warn
    await runIndexerHealthProbe(makeStub(950, 1000), 10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("respects a more lenient threshold", async () => {
    const warnSpy = jest.spyOn(require("../src/config/logger").logger, "warn");
    // lag = 200, threshold = 500  → should NOT warn
    await runIndexerHealthProbe(makeStub(800, 1000), 500);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
