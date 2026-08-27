/**
 * Deterministic oracle admission policy for market settlement.
 *
 * A settlement must be based on a bounded, internally consistent snapshot.
 * This module contains no network calls: callers fetch a snapshot from their
 * configured providers, then pass it through this guard immediately before
 * committing settlement state. Keeping admission pure makes clock, outage,
 * and recovery behavior reproducible in tests and auditable in production.
 */

export type OraclePrice = {
  source: string;
  price: number;
  observedAt: number;
};

export type OracleSnapshot = {
  marketId: string;
  prices: readonly OraclePrice[];
  fallback?: OraclePrice;
};

export type OracleSettlementPolicy = {
  maxAgeSeconds: number;
  minSources: number;
  maxDeviationBps: number;
  maxClockSkewSeconds: number;
  allowFallback: boolean;
};

export const DEFAULT_ORACLE_SETTLEMENT_POLICY: OracleSettlementPolicy = {
  maxAgeSeconds: 120,
  minSources: 3,
  maxDeviationBps: 100,
  maxClockSkewSeconds: 5,
  allowFallback: false,
};

export type OracleRejectionReason =
  | "market_mismatch"
  | "missing_prices"
  | "invalid_price"
  | "duplicate_source"
  | "stale_price"
  | "future_price"
  | "quorum_not_reached"
  | "deviation_exceeded"
  | "fallback_disabled"
  | "fallback_invalid";

export type OracleRejection = {
  accepted: false;
  reason: OracleRejectionReason;
  message: string;
  marketId: string;
  sourceCount: number;
  observedAt?: number;
};

export type OracleAcceptance = {
  accepted: true;
  marketId: string;
  price: number;
  sourceCount: number;
  sources: string[];
  observedAt: number;
  usedFallback: boolean;
};

export type OracleDecision = OracleAcceptance | OracleRejection;

export function evaluateOracleSnapshot(
  snapshot: OracleSnapshot,
  now: number,
  policy: OracleSettlementPolicy = DEFAULT_ORACLE_SETTLEMENT_POLICY,
  expectedMarketId?: string,
): OracleDecision {
  const normalized = normalizePolicy(policy);
  if (expectedMarketId !== undefined && snapshot.marketId !== expectedMarketId) {
    return reject("market_mismatch", "oracle snapshot belongs to a different market", snapshot, 0);
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return reject("future_price", "settlement clock is invalid", snapshot, 0);
  }
  if (!Array.isArray(snapshot.prices) || snapshot.prices.length === 0) {
    return reject("missing_prices", "no oracle prices were supplied", snapshot, 0);
  }

  const sourceNames = new Set<string>();
  const valid: OraclePrice[] = [];
  for (const price of snapshot.prices) {
    const structural = validatePrice(price);
    if (structural) return reject(structural, "oracle price failed validation", snapshot, valid.length);
    if (sourceNames.has(price.source)) return reject("duplicate_source", "oracle sources must be unique", snapshot, valid.length);
    sourceNames.add(price.source);
    if (price.observedAt > now + normalized.maxClockSkewSeconds) {
      return reject("future_price", "oracle observation is from the future", snapshot, valid.length, price.observedAt);
    }
    if (now - price.observedAt > normalized.maxAgeSeconds) {
      continue;
    }
    valid.push({ ...price });
  }

  if (valid.length < normalized.minSources) {
    return evaluateFallback(snapshot, now, normalized, sourceNames, valid.length);
  }

  const median = medianPrice(valid.map((item) => item.price));
  const outlier = valid.find((item) => deviationBps(item.price, median) > normalized.maxDeviationBps);
  if (outlier) {
    return reject("deviation_exceeded", "oracle prices exceed the configured deviation boundary", snapshot, valid.length, outlier.observedAt);
  }
  return {
    accepted: true,
    marketId: snapshot.marketId,
    price: median,
    sourceCount: valid.length,
    sources: valid.map((item) => item.source).sort(),
    observedAt: Math.min(...valid.map((item) => item.observedAt)),
    usedFallback: false,
  };
}

export function medianPrice(values: readonly number[]): number {
  if (values.length === 0) throw new Error("cannot calculate median of an empty set");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function deviationBps(value: number, reference: number): number {
  if (reference <= 0 || !Number.isFinite(reference)) return Number.POSITIVE_INFINITY;
  return Math.abs(value - reference) / reference * 10_000;
}

export function validatePrice(price: OraclePrice): OracleRejectionReason | undefined {
  if (!price || typeof price.source !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(price.source)) return "invalid_price";
  if (!Number.isFinite(price.price) || price.price <= 0) return "invalid_price";
  if (!Number.isSafeInteger(price.observedAt) || price.observedAt < 0) return "invalid_price";
  return undefined;
}

export function normalizePolicy(policy: OracleSettlementPolicy): OracleSettlementPolicy {
  if (!Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) throw new Error("maxAgeSeconds must be positive");
  if (!Number.isSafeInteger(policy.minSources) || policy.minSources <= 0) throw new Error("minSources must be positive");
  if (!Number.isSafeInteger(policy.maxDeviationBps) || policy.maxDeviationBps < 0 || policy.maxDeviationBps > 10_000) throw new Error("maxDeviationBps must be 0..10000");
  if (!Number.isSafeInteger(policy.maxClockSkewSeconds) || policy.maxClockSkewSeconds < 0) throw new Error("maxClockSkewSeconds must be non-negative");
  return { ...policy };
}

function evaluateFallback(
  snapshot: OracleSnapshot,
  now: number,
  policy: OracleSettlementPolicy,
  knownSources: Set<string>,
  validCount: number,
): OracleDecision {
  if (!policy.allowFallback) return reject("quorum_not_reached", `oracle quorum requires ${policy.minSources} fresh sources`, snapshot, validCount);
  if (!snapshot.fallback || knownSources.has(snapshot.fallback.source)) return reject("fallback_invalid", "fallback must be a distinct explicitly supplied source", snapshot, validCount);
  const fallbackError = validatePrice(snapshot.fallback);
  if (fallbackError || snapshot.fallback.observedAt > now + policy.maxClockSkewSeconds || now - snapshot.fallback.observedAt > policy.maxAgeSeconds) {
    return reject("fallback_invalid", "fallback price is invalid or outside its freshness window", snapshot, validCount);
  }
  return {
    accepted: true,
    marketId: snapshot.marketId,
    price: snapshot.fallback.price,
    sourceCount: 1,
    sources: [snapshot.fallback.source],
    observedAt: snapshot.fallback.observedAt,
    usedFallback: true,
  };
}

function reject(reason: OracleRejectionReason, message: string, snapshot: OracleSnapshot, sourceCount: number, observedAt?: number): OracleRejection {
  return { accepted: false, reason, message, marketId: snapshot.marketId, sourceCount, ...(observedAt === undefined ? {} : { observedAt }) };
}
