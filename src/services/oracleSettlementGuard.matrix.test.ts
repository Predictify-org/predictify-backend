import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_ORACLE_SETTLEMENT_POLICY,
  evaluateOracleSnapshot,
  type OraclePrice,
  type OracleSettlementPolicy,
} from "./oracleSettlementGuard";

const basePolicy: OracleSettlementPolicy = {
  ...DEFAULT_ORACLE_SETTLEMENT_POLICY,
  maxAgeSeconds: 60,
  minSources: 3,
  maxDeviationBps: 200,
  maxClockSkewSeconds: 2,
};

const observation = (source: string, price: number, observedAt = 1_000): OraclePrice => ({ source, price, observedAt });
const makeSnapshot = (prices: readonly OraclePrice[], fallback?: OraclePrice) => ({
  marketId: "mkt-42",
  prices,
  ...(fallback === undefined ? {} : { fallback }),
});

describe("oracle guard failure matrix", () => {
  const invalidPrices: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -0.01],
    ["nan", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ];

  for (const [label, value] of invalidPrices) {
    it(`rejects ${label} before quorum calculation`, () => {
      const result = evaluateOracleSnapshot(
        makeSnapshot([observation("source-a", value), observation("source-b", 10), observation("source-c", 10)]),
        1_000,
        basePolicy,
        "mkt-42",
      );
      expect(result).toMatchObject({ accepted: false, reason: "invalid_price", sourceCount: 0 });
    });
  }

  const invalidSources: Array<[string, string]> = [
    ["blank", ""],
    ["space", "source a"],
    ["slash", "source/a"],
    ["too long", "x".repeat(65)],
  ];

  for (const [label, source] of invalidSources) {
    it(`rejects ${label} source names`, () => {
      const result = evaluateOracleSnapshot(
        makeSnapshot([observation(source, 10), observation("source-b", 10), observation("source-c", 10)]),
        1_000,
        basePolicy,
      );
      expect(result.reason).toBe("invalid_price");
    });
  }

  for (const count of [0, 1, 2]) {
    it(`rejects ${count} fresh sources when three are required`, () => {
      const prices = Array.from({ length: count }, (_, index) => observation(`source-${index}`, 10));
      const result = evaluateOracleSnapshot(makeSnapshot(prices), 1_000, basePolicy);
      expect(result).toMatchObject({ accepted: false, reason: count === 0 ? "missing_prices" : "quorum_not_reached", sourceCount: count });
    });
  }

  for (const age of [61, 100, 1_000]) {
    it(`does not count an observation ${age} seconds old as fresh`, () => {
      const result = evaluateOracleSnapshot(
        makeSnapshot([observation("source-a", 10, 1_000 - age), observation("source-b", 10), observation("source-c", 10)]),
        1_000,
        basePolicy,
      );
      expect(result).toMatchObject({ accepted: false, reason: "quorum_not_reached", sourceCount: 2 });
    });
  }

  for (const skew of [3, 10, 1_000_000]) {
    it(`rejects an observation ${skew} seconds in the future`, () => {
      const result = evaluateOracleSnapshot(
        makeSnapshot([observation("source-a", 10, 1_000 + skew), observation("source-b", 10), observation("source-c", 10)]),
        1_000,
        basePolicy,
      );
      expect(result).toMatchObject({ accepted: false, reason: "future_price" });
    });
  }

  for (const deviation of [201, 500, 2_000, 10_000]) {
    it(`rejects a ${deviation} bps outlier`, () => {
      const result = evaluateOracleSnapshot(
        makeSnapshot([observation("source-a", 100), observation("source-b", 100), observation("source-c", 100 * (1 + deviation / 10_000))]),
        1_000,
        basePolicy,
      );
      expect(result).toMatchObject({ accepted: false, reason: "deviation_exceeded" });
    });
  }

  it("does not let stale outliers affect a fresh median", () => {
    const result = evaluateOracleSnapshot(
      makeSnapshot([observation("source-a", 100), observation("source-b", 100), observation("source-c", 10_000, 900)]),
      1_000,
      basePolicy,
    );
    expect(result).toMatchObject({ accepted: false, reason: "quorum_not_reached", sourceCount: 2 });
  });

  it("does not let a fallback replace a valid quorum", () => {
    const result = evaluateOracleSnapshot(
      makeSnapshot([observation("source-a", 100), observation("source-b", 100), observation("source-c", 100)], observation("fallback", 1)),
      1_000,
      { ...basePolicy, allowFallback: true },
    );
    expect(result).toMatchObject({ accepted: true, price: 100, usedFallback: false, sourceCount: 3 });
  });

  it("rejects fallback values that exceed the clock skew", () => {
    const result = evaluateOracleSnapshot(
      makeSnapshot([observation("source-a", 100)], observation("fallback", 100, 1_003)),
      1_000,
      { ...basePolicy, allowFallback: true },
    );
    expect(result).toMatchObject({ accepted: false, reason: "fallback_invalid" });
  });

  it("makes identical snapshots produce identical serialized decisions", () => {
    const input = makeSnapshot([observation("source-z", 100), observation("source-a", 100), observation("source-m", 100)]);
    const first = evaluateOracleSnapshot(input, 1_000, basePolicy);
    const second = evaluateOracleSnapshot(input, 1_000, basePolicy);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("does not mutate a caller-owned price array", () => {
    const prices = [observation("source-z", 100), observation("source-a", 100), observation("source-m", 100)];
    evaluateOracleSnapshot(makeSnapshot(prices), 1_000, basePolicy);
    expect(prices.map((item) => item.source)).toEqual(["source-z", "source-a", "source-m"]);
  });

  it("keeps the oldest accepted observation timestamp for auditability", () => {
    const result = evaluateOracleSnapshot(
      makeSnapshot([observation("source-a", 100, 950), observation("source-b", 100, 999), observation("source-c", 100, 970)]),
      1_000,
      basePolicy,
    );
    expect(result).toMatchObject({ accepted: true, observedAt: 950 });
  });
});
