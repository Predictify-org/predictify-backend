import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_ORACLE_SETTLEMENT_POLICY,
  deviationBps,
  evaluateOracleSnapshot,
  medianPrice,
  normalizePolicy,
  validatePrice,
} from "./oracleSettlementGuard";

const price = (source: string, value: number, observedAt = 900) => ({ source, price: value, observedAt });
const snapshot = (prices: ReturnType<typeof price>[], fallback?: ReturnType<typeof price>) => ({ marketId: "market-1", prices, ...(fallback ? { fallback } : {}) });
const policy = { ...DEFAULT_ORACLE_SETTLEMENT_POLICY, minSources: 3, maxAgeSeconds: 100 };

describe("oracle settlement guard", () => {
  it("accepts a fresh quorum and returns the deterministic median", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100), price("b", 101), price("c", 99)]), 1_000, policy, "market-1");
    expect(result).toEqual({ accepted: true, marketId: "market-1", price: 100, sourceCount: 3, sources: ["a", "b", "c"], observedAt: 900, usedFallback: false });
  });

  it("rejects missing observations and wrong markets", () => {
    expect(evaluateOracleSnapshot(snapshot([]), 1_000, policy).reason).toBe("missing_prices");
    expect(evaluateOracleSnapshot({ ...snapshot([price("a", 1), price("b", 1), price("c", 1)]), marketId: "other" }, 1_000, policy, "market-1")).toMatchObject({ reason: "market_mismatch" });
  });

  it("rejects stale data instead of treating it as a valid quorum", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100, 899), price("b", 100, 899), price("c", 100, 899)]), 1_000, policy);
    expect(result).toMatchObject({ accepted: false, reason: "quorum_not_reached", sourceCount: 0 });
  });

  it("accepts the exact freshness boundary and rejects one second older", () => {
    expect(evaluateOracleSnapshot(snapshot([price("a", 100, 900), price("b", 100, 900), price("c", 100, 900)]), 1_000, policy).accepted).toBe(true);
    expect(evaluateOracleSnapshot(snapshot([price("a", 100, 899), price("b", 100, 899), price("c", 100, 899)]), 1_000, policy).accepted).toBe(false);
  });

  it("rejects future observations beyond the allowed clock skew", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100, 1_006), price("b", 100), price("c", 100)]), 1_000, policy);
    expect(result).toMatchObject({ accepted: false, reason: "future_price", observedAt: 1_006 });
  });

  it("allows bounded clock skew", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100, 1_005), price("b", 100), price("c", 100)]), 1_000, policy);
    expect(result.accepted).toBe(true);
  });

  it("rejects zero, negative, NaN, and infinite prices", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateOracleSnapshot(snapshot([price("a", value), price("b", 1), price("c", 1)]), 1_000, policy);
      expect(result.reason).toBe("invalid_price");
    }
  });

  it("rejects duplicate and malformed source identities", () => {
    expect(evaluateOracleSnapshot(snapshot([price("a", 1), price("a", 1), price("c", 1)]), 1_000, policy).reason).toBe("duplicate_source");
    expect(validatePrice(price("bad source", 1))).toBe("invalid_price");
  });

  it("rejects a deterministic outlier beyond the deviation boundary", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100), price("b", 100), price("c", 102)]), 1_000, { ...policy, maxDeviationBps: 100 });
    expect(result).toMatchObject({ accepted: false, reason: "deviation_exceeded", sourceCount: 3 });
  });

  it("accepts values exactly on the deviation boundary", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100), price("b", 100), price("c", 101)]), 1_000, { ...policy, maxDeviationBps: 100 });
    expect(result.accepted).toBe(true);
  });

  it("rejects below-quorum snapshots when fallback is disabled", () => {
    const result = evaluateOracleSnapshot(snapshot([price("a", 100), price("b", 100)]), 1_000, policy);
    expect(result).toMatchObject({ accepted: false, reason: "quorum_not_reached" });
  });

  it("uses an explicit fresh fallback only when enabled", () => {
    const input = snapshot([price("a", 100)], price("fallback", 101));
    expect(evaluateOracleSnapshot(input, 1_000, { ...policy, allowFallback: false }).reason).toBe("quorum_not_reached");
    expect(evaluateOracleSnapshot(input, 1_000, { ...policy, allowFallback: true })).toMatchObject({ accepted: true, price: 101, usedFallback: true, sourceCount: 1 });
  });

  it("rejects a fallback that is stale, duplicated, or malformed", () => {
    expect(evaluateOracleSnapshot(snapshot([price("a", 100)], price("fallback", 101, 899)), 1_000, { ...policy, allowFallback: true }).reason).toBe("fallback_invalid");
    expect(evaluateOracleSnapshot(snapshot([price("a", 100)], price("a", 101)), 1_000, { ...policy, allowFallback: true }).reason).toBe("fallback_invalid");
    expect(evaluateOracleSnapshot(snapshot([price("a", 100)], price("bad source", 101)), 1_000, { ...policy, allowFallback: true }).reason).toBe("fallback_invalid");
  });

  it("keeps source ordering stable for audit records", () => {
    const result = evaluateOracleSnapshot(snapshot([price("z", 100), price("a", 100), price("m", 100)]), 1_000, policy);
    expect(result).toMatchObject({ accepted: true, sources: ["a", "m", "z"] });
  });

  it("calculates odd and even medians without mutating inputs", () => {
    const values = [3, 1, 2];
    expect(medianPrice(values)).toBe(2);
    expect(medianPrice([4, 1, 3, 2])).toBe(2.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it("calculates deviations in basis points", () => {
    expect(deviationBps(101, 100)).toBe(100);
    expect(deviationBps(99, 100)).toBe(100);
    expect(deviationBps(0, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("validates policy boundaries", () => {
    expect(normalizePolicy(policy)).toEqual(policy);
    for (const invalid of [
      { ...policy, maxAgeSeconds: 0 },
      { ...policy, minSources: 0 },
      { ...policy, maxDeviationBps: 10_001 },
      { ...policy, maxClockSkewSeconds: -1 },
    ]) expect(() => normalizePolicy(invalid)).toThrow();
  });

  it("rejects an invalid settlement clock", () => {
    expect(evaluateOracleSnapshot(snapshot([price("a", 1), price("b", 1), price("c", 1)]), Number.NaN, policy).reason).toBe("future_price");
  });
});
