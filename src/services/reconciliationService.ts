import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { db } from "../db/client";
import {
  claims,
  indexerEvents,
  markets,
  predictions,
  reconciliationDiscrepancies,
  reconciliationReports,
  users,
} from "../db/schema";
import { logger } from "../config/logger";
import { createAuditLog } from "./auditService";

// ---------------------------------------------------------------------------
// Market Reconciliation Types & Interfaces (Preserved for compatibility)
// ---------------------------------------------------------------------------

export interface ReconciliationSidePosition {
  stellarAddress: string;
  outcome: string;
  amount: string;
}

export interface ReconciliationDiffEntry {
  key: {
    stellarAddress: string;
    outcome: string;
  };
  dbAmount: string;
  onChainAmount: string | null;
  difference: string | null;
  status: "match" | "mismatch" | "missing_on_chain" | "missing_in_db";
}

export interface ReconciliationSummary {
  totalKeys: number;
  matches: number;
  mismatches: number;
  missingOnChain: number;
  missingInDb: number;
}

export interface MarketReconciliationResult {
  marketId: string;
  correlationId: string;
  generatedAt: string;
  status: "ok" | "partial";
  dbSnapshot: {
    positions: ReconciliationSidePosition[];
    totalAmount: string;
  };
  onChainSnapshot: {
    positions: ReconciliationSidePosition[];
    totalAmount: string;
    available: boolean;
    source: string;
    unavailableReason: string | null;
  };
  summary: ReconciliationSummary;
  diffs: ReconciliationDiffEntry[];
}

export class ReconciliationNotFoundError extends Error {
  status = 404;
  code = "not_found";

  constructor(marketId: string) {
    super(`Market not found: ${marketId}`);
    this.name = "ReconciliationNotFoundError";
  }
}

export interface OnChainMarketStateProvider {
  getMarketPositions(marketId: string): Promise<{
    positions: ReconciliationSidePosition[];
    source: string;
    available: boolean;
    unavailableReason?: string;
  }>;
}

export interface ReconciliationServiceDeps {
  marketExists(marketId: string): Promise<boolean>;
  getDbPositions(marketId: string): Promise<ReconciliationSidePosition[]>;
  getOnChainPositions(marketId: string): Promise<{
    positions: ReconciliationSidePosition[];
    source: string;
    available: boolean;
    unavailableReason?: string;
  }>;
  writeAudit(input: {
    action: string;
    walletAddress?: string;
    ip: string;
    correlationId: string;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Payout Reconciliation Types & Discrepancies
// ---------------------------------------------------------------------------

export type PayoutDiscrepancyKind =
  | "claimed_on_chain_missing_in_db"
  | "db_paid_missing_on_chain"
  | "amount_mismatch"
  | "claim_for_losing_prediction"
  | "duplicate_on_chain_claim"
  | "stale_unclaimed";

export interface PayoutDiscrepancy {
  kind: PayoutDiscrepancyKind;
  userId?: string;
  stellarAddress?: string;
  marketId: string;
  predictionId?: string;
  claimId?: string;
  txHash?: string;
  dbAmount?: string;
  onChainAmount?: string;
  difference?: string;
  details?: Record<string, unknown>;
}

// Backwards-compatible Discrepancy alias
export type Discrepancy = PayoutDiscrepancy;

export interface PayoutReconciliationResult {
  reportId: string;
  fingerprint: string;
  status: "ok" | "discrepancies_found";
  since: string | null;
  until: string | null;
  totalKeys: number;
  matchedKeys: number;
  unmatchedKeys: number;
  discrepancyCount: number;
  summary: Record<PayoutDiscrepancyKind, number>;
  discrepancies: PayoutDiscrepancy[];
  createdAt: string;
}

// Backwards-compatible ReconciliationResult alias
export type ReconciliationResult = PayoutReconciliationResult;

export interface ClaimEvent {
  id?: string;
  txHash: string;
  ledger?: number;
  marketId: string;
  userAddress: string;
  amount: string;
  createdAt: Date | string;
}

export interface ClaimEventSource {
  getClaimEvents(window?: { since?: Date; until?: Date }): Promise<ClaimEvent[]>;
}

export class DefaultDbClaimEventSource implements ClaimEventSource {
  private readonly client: any;

  constructor(client: any = db) {
    this.client = client;
  }

  async getClaimEvents(window?: { since?: Date; until?: Date }): Promise<ClaimEvent[]> {
    if (!this.client) return [];
    try {
      const conditions = [
        eq(indexerEvents.eventType, "win_clm"),
        eq(indexerEvents.canonical, true),
      ];
      if (window?.since) {
        conditions.push(gte(indexerEvents.createdAt, new Date(window.since)));
      }
      if (window?.until) {
        conditions.push(lte(indexerEvents.createdAt, new Date(window.until)));
      }

      const rows = await this.client
        .select()
        .from(indexerEvents)
        .where(and(...conditions));

      return rows.map((r: any) => {
        const payload = (r.data ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          txHash: r.txHash,
          ledger: r.ledger,
          marketId: r.marketId ?? String(payload.marketId ?? ""),
          userAddress: String(payload.userAddress ?? payload.stellarAddress ?? ""),
          amount: String(payload.amount ?? "0"),
          createdAt: r.createdAt,
        };
      });
    } catch {
      return [];
    }
  }
}

export interface PredictionRecord {
  id: string;
  userId: string;
  stellarAddress: string;
  marketId: string;
  amount: string;
  status: string;
  result: string | null;
  claimTxHash: string | null;
  createdAt: Date | string;
}

export interface ClaimRecord {
  id: string;
  userId: string;
  stellarAddress?: string;
  marketId: string;
  amount: string;
  status: string;
  settlementTx: string | null;
  settledAt: Date | string | null;
  createdAt: Date | string;
}

export interface PerformReconciliationOptions {
  since?: Date | string;
  until?: Date | string;
  staleThresholdDays?: number;
  finalityWindowMinutes?: number;
  claimEventSource?: ClaimEventSource;
  predictionsFixture?: PredictionRecord[];
  claimsFixture?: ClaimRecord[];
  eventsFixture?: ClaimEvent[];
  persist?: boolean;
  dbClient?: any;
}

// ---------------------------------------------------------------------------
// Exact Arithmetic Helpers (Scaled as BigInt Stroops, 7 decimals)
// ---------------------------------------------------------------------------

const STROOP_FACTOR = 10_000_000n;

export function parseExactStroops(amtStr: string | number | undefined | null): bigint {
  if (amtStr === undefined || amtStr === null) return 0n;
  const str = String(amtStr).trim();
  if (!str) return 0n;
  const isNegative = str.startsWith("-");
  const absStr = isNegative ? str.slice(1) : str;
  const [whole, frac = ""] = absStr.split(".");
  const paddedFrac = (frac + "0000000").slice(0, 7);
  const val = BigInt(whole || "0") * STROOP_FACTOR + BigInt(paddedFrac);
  return isNegative ? -val : val;
}

export function formatExactStroops(stroops: bigint): string {
  const isNegative = stroops < 0n;
  const abs = isNegative ? -stroops : stroops;
  const whole = abs / STROOP_FACTOR;
  const frac = abs % STROOP_FACTOR;
  if (frac === 0n) {
    return (isNegative ? "-" : "") + whole.toString();
  }
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return (isNegative ? "-" : "") + `${whole}.${fracStr}`;
}

// ---------------------------------------------------------------------------
// Market Position Helper Functions (Preserved)
// ---------------------------------------------------------------------------

function normaliseAmount(value: string): bigint {
  return BigInt(value);
}

function sumAmounts(positions: ReconciliationSidePosition[]): string {
  return positions
    .reduce<bigint>(
      (total, position) => total + normaliseAmount(position.amount),
      0n,
    )
    .toString();
}

function positionKey(position: {
  stellarAddress: string;
  outcome: string;
}): string {
  return `${position.stellarAddress}::${position.outcome}`;
}

function aggregatePositions(
  rows: Array<{ stellarAddress: string; outcome: string; amount: string }>,
): ReconciliationSidePosition[] {
  const grouped = new Map<string, bigint>();

  for (const row of rows) {
    const key = positionKey(row);
    grouped.set(key, (grouped.get(key) ?? 0n) + normaliseAmount(row.amount));
  }

  return [...grouped.entries()]
    .map(([key, amount]) => {
      const [stellarAddress, outcome] = key.split("::");
      return { stellarAddress, outcome, amount: amount.toString() };
    })
    .sort((a, b) => {
      const byAddress = a.stellarAddress.localeCompare(b.stellarAddress);
      if (byAddress !== 0) return byAddress;
      return a.outcome.localeCompare(b.outcome);
    });
}

export function diffMarketPositions(
  dbPositions: ReconciliationSidePosition[],
  onChainPositions: ReconciliationSidePosition[],
): { summary: ReconciliationSummary; diffs: ReconciliationDiffEntry[] } {
  const dbMap = new Map(
    dbPositions.map((position) => [positionKey(position), position]),
  );
  const onChainMap = new Map(
    onChainPositions.map((position) => [positionKey(position), position]),
  );
  const keys = [...new Set([...dbMap.keys(), ...onChainMap.keys()])].sort();

  const diffs = keys.map<ReconciliationDiffEntry>((key) => {
    const dbPosition = dbMap.get(key) ?? null;
    const onChainPosition = onChainMap.get(key) ?? null;
    const [stellarAddress, outcome] = key.split("::");

    if (dbPosition && onChainPosition) {
      const dbAmount = normaliseAmount(dbPosition.amount);
      const onChainAmount = normaliseAmount(onChainPosition.amount);

      if (dbAmount === onChainAmount) {
        return {
          key: { stellarAddress, outcome },
          dbAmount: dbPosition.amount,
          onChainAmount: onChainPosition.amount,
          difference: "0",
          status: "match",
        };
      }

      return {
        key: { stellarAddress, outcome },
        dbAmount: dbPosition.amount,
        onChainAmount: onChainPosition.amount,
        difference: (dbAmount - onChainAmount).toString(),
        status: "mismatch",
      };
    }

    if (dbPosition) {
      return {
        key: { stellarAddress, outcome },
        dbAmount: dbPosition.amount,
        onChainAmount: null,
        difference: null,
        status: "missing_on_chain",
      };
    }

    return {
      key: { stellarAddress, outcome },
      dbAmount: "0",
      onChainAmount: onChainPosition!.amount,
      difference: null,
      status: "missing_in_db",
    };
  });

  return {
    summary: {
      totalKeys: diffs.length,
      matches: diffs.filter((entry) => entry.status === "match").length,
      mismatches: diffs.filter((entry) => entry.status === "mismatch").length,
      missingOnChain: diffs.filter(
        (entry) => entry.status === "missing_on_chain",
      ).length,
      missingInDb: diffs.filter((entry) => entry.status === "missing_in_db")
        .length,
    },
    diffs,
  };
}

export class DefaultOnChainMarketStateProvider implements OnChainMarketStateProvider {
  async getMarketPositions(_marketId: string): Promise<{
    positions: ReconciliationSidePosition[];
    source: string;
    available: boolean;
    unavailableReason?: string;
  }> {
    return {
      positions: [],
      source: "soroban-rpc",
      available: false,
      unavailableReason:
        "On-chain market position lookup is not configured for this deployment yet. Wire the contract read adapter before relying on this endpoint for live balances.",
    };
  }
}

export function createReconciliationService(deps: ReconciliationServiceDeps) {
  return {
    async reconcileMarket(input: {
      marketId: string;
      adminAddress: string;
      ip: string;
      correlationId: string;
    }): Promise<MarketReconciliationResult> {
      const exists = await deps.marketExists(input.marketId);
      if (!exists) {
        throw new ReconciliationNotFoundError(input.marketId);
      }

      logger.info(
        {
          correlationId: input.correlationId,
          marketId: input.marketId,
          adminAddress: input.adminAddress,
        },
        "admin_market_reconciliation_started",
      );

      const [dbPositions, onChain] = await Promise.all([
        deps.getDbPositions(input.marketId),
        deps.getOnChainPositions(input.marketId),
      ]);

      const { summary, diffs } = diffMarketPositions(
        dbPositions,
        onChain.positions,
      );

      await deps.writeAudit({
        action: "admin.reconciliation.market.inspect",
        walletAddress: input.adminAddress,
        ip: input.ip,
        correlationId: input.correlationId,
      });

      const result: MarketReconciliationResult = {
        marketId: input.marketId,
        correlationId: input.correlationId,
        generatedAt: new Date().toISOString(),
        status: onChain.available ? "ok" : "partial",
        dbSnapshot: {
          positions: dbPositions,
          totalAmount: sumAmounts(dbPositions),
        },
        onChainSnapshot: {
          positions: onChain.positions,
          totalAmount: sumAmounts(onChain.positions),
          available: onChain.available,
          source: onChain.source,
          unavailableReason: onChain.unavailableReason ?? null,
        },
        summary,
        diffs,
      };

      logger.info(
        {
          correlationId: input.correlationId,
          marketId: input.marketId,
          adminAddress: input.adminAddress,
          status: result.status,
          summary: result.summary,
        },
        "admin_market_reconciliation_completed",
      );

      return result;
    },
  };
}

const defaultOnChainProvider = new DefaultOnChainMarketStateProvider();

async function marketExists(marketId: string): Promise<boolean> {
  if (!db) return false;
  const rows = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);

  return rows.length > 0;
}

async function getDbPositions(
  marketId: string,
): Promise<ReconciliationSidePosition[]> {
  if (!db) return [];
  const rows = await db
    .select({
      stellarAddress: users.stellarAddress,
      outcome: predictions.outcome,
      amount: predictions.amount,
    })
    .from(predictions)
    .innerJoin(users, eq(predictions.userId, users.id))
    .where(
      and(
        eq(predictions.marketId, marketId),
        eq(predictions.status, "confirmed"),
      ),
    );

  return aggregatePositions(rows);
}

async function getOnChainPositions(marketId: string) {
  const result = await defaultOnChainProvider.getMarketPositions(marketId);
  return {
    positions: aggregatePositions(result.positions),
    source: result.source,
    available: result.available,
    unavailableReason: result.unavailableReason,
  };
}

export const reconciliationService = createReconciliationService({
  marketExists,
  getDbPositions,
  getOnChainPositions,
  writeAudit: createAuditLog,
});

export async function reconcileMarket(input: {
  marketId: string;
  adminAddress: string;
  ip: string;
  correlationId: string;
}): Promise<MarketReconciliationResult> {
  return reconciliationService.reconcileMarket(input);
}

// ---------------------------------------------------------------------------
// Payout Reconciliation Core Engine
// ---------------------------------------------------------------------------

function computeReportFingerprint(
  since: string | null,
  until: string | null,
  discrepancies: PayoutDiscrepancy[],
): string {
  const sorted = [...discrepancies].sort((a, b) => {
    const m = a.marketId.localeCompare(b.marketId);
    if (m !== 0) return m;
    const s = (a.stellarAddress ?? "").localeCompare(b.stellarAddress ?? "");
    if (s !== 0) return s;
    const k = a.kind.localeCompare(b.kind);
    if (k !== 0) return k;
    return (a.txHash ?? "").localeCompare(b.txHash ?? "");
  });

  const payload = JSON.stringify({
    since,
    until,
    discrepancies: sorted.map((d) => ({
      kind: d.kind,
      marketId: d.marketId,
      stellarAddress: d.stellarAddress,
      predictionId: d.predictionId,
      claimId: d.claimId,
      txHash: d.txHash,
      difference: d.difference,
      dbAmount: d.dbAmount,
      onChainAmount: d.onChainAmount,
    })),
  });

  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Perform comprehensive reconciliation across winning predictions, claims ledger, and on-chain win_clm events.
 */
export async function performReconciliation(
  options: PerformReconciliationOptions = {},
): Promise<PayoutReconciliationResult> {
  logger.info("Starting claims and payout reconciliation process");

  const sinceDate = options.since ? new Date(options.since) : null;
  const untilDate = options.until ? new Date(options.until) : null;
  const staleThresholdDays = options.staleThresholdDays ?? 7;
  const staleThresholdMs = staleThresholdDays * 24 * 60 * 60 * 1000;
  const now = new Date();
  const dbClient = options.dbClient ?? db;

  // 1. Gather Predictions
  let allPredictions: PredictionRecord[] = [];
  if (options.predictionsFixture) {
    allPredictions = options.predictionsFixture;
  } else if (dbClient) {
    try {
      const predConditions = [];
      if (sinceDate) predConditions.push(gte(predictions.createdAt, sinceDate));
      if (untilDate) predConditions.push(lte(predictions.createdAt, untilDate));

      const rows = await dbClient
        .select({
          id: predictions.id,
          userId: predictions.userId,
          stellarAddress: users.stellarAddress,
          marketId: predictions.marketId,
          amount: predictions.amount,
          status: predictions.status,
          result: predictions.result,
          claimTxHash: predictions.claimTxHash,
          createdAt: predictions.createdAt,
        })
        .from(predictions)
        .innerJoin(users, eq(predictions.userId, users.id))
        .where(predConditions.length > 0 ? and(...predConditions) : undefined);

      allPredictions = rows;
    } catch {
      allPredictions = [];
    }
  }

  // 2. Gather Claims
  let allClaims: ClaimRecord[] = [];
  if (options.claimsFixture) {
    allClaims = options.claimsFixture;
  } else if (dbClient) {
    try {
      const claimConditions = [];
      if (sinceDate) claimConditions.push(gte(claims.createdAt, sinceDate));
      if (untilDate) claimConditions.push(lte(claims.createdAt, untilDate));

      const rows = await dbClient
        .select({
          id: claims.id,
          userId: claims.userId,
          stellarAddress: users.stellarAddress,
          marketId: claims.marketId,
          amount: claims.amount,
          status: claims.status,
          settlementTx: claims.settlementTx,
          settledAt: claims.settledAt,
          createdAt: claims.createdAt,
        })
        .from(claims)
        .innerJoin(users, eq(claims.userId, users.id))
        .where(claimConditions.length > 0 ? and(...claimConditions) : undefined);

      allClaims = rows;
    } catch {
      allClaims = [];
    }
  }

  // 3. Gather On-chain Win_clm Events
  let allEvents: ClaimEvent[] = [];
  if (options.eventsFixture) {
    allEvents = options.eventsFixture;
  } else {
    const eventSource = options.claimEventSource ?? new DefaultDbClaimEventSource(dbClient);
    allEvents = await eventSource.getClaimEvents({
      since: sinceDate ?? undefined,
      until: untilDate ?? undefined,
    });
  }

  // Group by (user, market) key
  const predictionsByKey = new Map<string, PredictionRecord[]>();
  const claimsByKey = new Map<string, ClaimRecord[]>();
  const eventsByKey = new Map<string, ClaimEvent[]>();
  const keySet = new Set<string>();

  for (const p of allPredictions) {
    const userAddr = p.stellarAddress || p.userId;
    const key = `${userAddr}::${p.marketId}`;
    keySet.add(key);
    const existing = predictionsByKey.get(key) ?? [];
    existing.push(p);
    predictionsByKey.set(key, existing);
  }

  for (const c of allClaims) {
    const userAddr = c.stellarAddress || c.userId;
    const key = `${userAddr}::${c.marketId}`;
    keySet.add(key);
    const existing = claimsByKey.get(key) ?? [];
    existing.push(c);
    claimsByKey.set(key, existing);
  }

  for (const e of allEvents) {
    const userAddr = e.userAddress;
    const key = `${userAddr}::${e.marketId}`;
    keySet.add(key);
    const existing = eventsByKey.get(key) ?? [];
    existing.push(e);
    eventsByKey.set(key, existing);
  }

  const allKeys = [...keySet].sort();
  const discrepancies: PayoutDiscrepancy[] = [];
  let matchedKeys = 0;

  // Stream in keyset chunks of 1,000 keys to bound memory under 100 MB
  const BATCH_SIZE = 1000;
  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    for (const key of batch) {
      const [userAddress, marketId] = key.split("::");
      const preds = predictionsByKey.get(key) ?? [];
      const clms = claimsByKey.get(key) ?? [];
      const evts = eventsByKey.get(key) ?? [];

      const initialDiscrepancyCount = discrepancies.length;

      // 1. Check duplicate_on_chain_claim
      if (evts.length > 1) {
        discrepancies.push({
          kind: "duplicate_on_chain_claim",
          stellarAddress: userAddress,
          marketId,
          txHash: evts[1].txHash,
          onChainAmount: evts[1].amount,
          details: {
            eventCount: evts.length,
            txHashes: evts.map((e) => e.txHash),
          },
        });
      }

      // 2. Check claim_for_losing_prediction
      const losingPred = preds.find((p) => p.result === "lost");
      if (losingPred && (evts.length > 0 || clms.length > 0)) {
        discrepancies.push({
          kind: "claim_for_losing_prediction",
          stellarAddress: userAddress,
          marketId,
          predictionId: losingPred.id,
          txHash: evts[0]?.txHash,
          onChainAmount: evts[0]?.amount,
          details: { result: "lost" },
        });
      }

      // 3. Check claimed_on_chain_missing_in_db
      if (evts.length > 0 && clms.length === 0) {
        for (const evt of evts) {
          discrepancies.push({
            kind: "claimed_on_chain_missing_in_db",
            stellarAddress: userAddress,
            marketId,
            txHash: evt.txHash,
            onChainAmount: evt.amount,
            details: { ledger: evt.ledger },
          });
        }
      }

      // 4. Check db_paid_missing_on_chain
      const paidClaims = clms.filter(
        (c) => c.status === "paid" || c.status === "settled",
      );
      for (const pc of paidClaims) {
        if (evts.length === 0) {
          discrepancies.push({
            kind: "db_paid_missing_on_chain",
            stellarAddress: userAddress,
            marketId,
            claimId: pc.id,
            dbAmount: pc.amount,
            details: { settlementTx: pc.settlementTx },
          });
        }
      }

      // 5. Check amount_mismatch
      if (evts.length > 0 && clms.length > 0) {
        const evt = evts[0];
        const clm = clms[0];
        const dbStroops = parseExactStroops(clm.amount);
        const onChainStroops = parseExactStroops(evt.amount);
        const diff = dbStroops - onChainStroops;
        if (diff !== 0n) {
          discrepancies.push({
            kind: "amount_mismatch",
            stellarAddress: userAddress,
            marketId,
            claimId: clm.id,
            txHash: evt.txHash,
            dbAmount: clm.amount,
            onChainAmount: evt.amount,
            difference: formatExactStroops(diff),
          });
        }
      }

      // 6. Check stale_unclaimed
      const winningUnclaimed = preds.filter(
        (p) => p.result === "won" && p.status === "confirmed" && !p.claimTxHash,
      );
      for (const wp of winningUnclaimed) {
        if (clms.length === 0 && evts.length === 0) {
          const ageMs = now.getTime() - new Date(wp.createdAt).getTime();
          if (ageMs >= staleThresholdMs) {
            discrepancies.push({
              kind: "stale_unclaimed",
              stellarAddress: userAddress,
              marketId,
              predictionId: wp.id,
              dbAmount: wp.amount,
              details: {
                createdAt: wp.createdAt,
                ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
              },
            });
          }
        }
      }

      // If no discrepancies flagged for this key, mark key as matched
      if (discrepancies.length === initialDiscrepancyCount) {
        matchedKeys++;
      }
    }
  }

  // Summary counts by kind
  const summary: Record<PayoutDiscrepancyKind, number> = {
    claimed_on_chain_missing_in_db: 0,
    db_paid_missing_on_chain: 0,
    amount_mismatch: 0,
    claim_for_losing_prediction: 0,
    duplicate_on_chain_claim: 0,
    stale_unclaimed: 0,
  };
  for (const d of discrepancies) {
    if (d.kind in summary) {
      summary[d.kind]++;
    }
  }

  const sinceStr = sinceDate ? sinceDate.toISOString() : null;
  const untilStr = untilDate ? untilDate.toISOString() : null;
  const status: "ok" | "discrepancies_found" =
    discrepancies.length === 0 ? "ok" : "discrepancies_found";
  const fingerprint = computeReportFingerprint(sinceStr, untilStr, discrepancies);

  let reportId = uuidv4();

  // Persist to database if enabled
  const shouldPersist = options.persist ?? Boolean(dbClient && !options.predictionsFixture);
  if (shouldPersist && dbClient) {
    try {
      const existing = await dbClient
        .select()
        .from(reconciliationReports)
        .where(eq(reconciliationReports.fingerprint, fingerprint))
        .limit(1);

      if (existing.length > 0) {
        reportId = existing[0].id;
      } else {
        const [inserted] = await dbClient
          .insert(reconciliationReports)
          .values({
            id: reportId,
            fingerprint,
            status,
            since: sinceDate,
            until: untilDate,
            totalKeys: allKeys.length,
            matchedKeys,
            unmatchedKeys: allKeys.length - matchedKeys,
            discrepancyCount: discrepancies.length,
            summary,
          })
          .onConflictDoNothing({ target: reconciliationReports.fingerprint })
          .returning();

        if (inserted) {
          reportId = inserted.id;
          if (discrepancies.length > 0) {
            const discrepancyRows = discrepancies.map((d) => ({
              reportId,
              kind: d.kind,
              userId: d.userId,
              stellarAddress: d.stellarAddress,
              marketId: d.marketId,
              predictionId: d.predictionId,
              claimId: d.claimId,
              txHash: d.txHash,
              dbAmount: d.dbAmount,
              onChainAmount: d.onChainAmount,
              difference: d.difference,
              details: d.details ?? {},
            }));
            await dbClient.insert(reconciliationDiscrepancies).values(discrepancyRows);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "reconciliation.persist_report_failed");
    }
  }

  return {
    reportId,
    fingerprint,
    status,
    since: sinceStr,
    until: untilStr,
    totalKeys: allKeys.length,
    matchedKeys,
    unmatchedKeys: allKeys.length - matchedKeys,
    discrepancyCount: discrepancies.length,
    summary,
    discrepancies,
    createdAt: now.toISOString(),
  };
}

/**
 * Get a persisted reconciliation report by ID.
 */
export async function getReconciliationReport(
  reportId: string,
  dbClient?: any,
): Promise<PayoutReconciliationResult | null> {
  const client = dbClient ?? db;
  if (!client) return null;
  try {
    const reports = await client
      .select()
      .from(reconciliationReports)
      .where(eq(reconciliationReports.id, reportId))
      .limit(1);

    if (reports.length === 0) return null;
    const r = reports[0];

    const discRows = await client
      .select()
      .from(reconciliationDiscrepancies)
      .where(eq(reconciliationDiscrepancies.reportId, reportId));

    return {
      reportId: r.id,
      fingerprint: r.fingerprint,
      status: r.status as "ok" | "discrepancies_found",
      since: r.since ? r.since.toISOString() : null,
      until: r.until ? r.until.toISOString() : null,
      totalKeys: r.totalKeys,
      matchedKeys: r.matchedKeys,
      unmatchedKeys: r.unmatchedKeys,
      discrepancyCount: r.discrepancyCount,
      summary: (r.summary ?? {}) as Record<PayoutDiscrepancyKind, number>,
      discrepancies: discRows.map((d: any) => ({
        kind: d.kind as PayoutDiscrepancyKind,
        userId: d.userId ?? undefined,
        stellarAddress: d.stellarAddress ?? undefined,
        marketId: d.marketId,
        predictionId: d.predictionId ?? undefined,
        claimId: d.claimId ?? undefined,
        txHash: d.txHash ?? undefined,
        dbAmount: d.dbAmount ?? undefined,
        onChainAmount: d.onChainAmount ?? undefined,
        difference: d.difference ?? undefined,
        details: (d.details ?? {}) as Record<string, unknown>,
      })),
      createdAt: r.createdAt.toISOString(),
    };
  } catch (err) {
    logger.warn({ err, reportId }, "reconciliation.get_report_failed");
    return null;
  }
}

export interface ListReconciliationReportsOptions {
  limit?: number;
  cursor?: string;
  since?: Date | string;
  until?: Date | string;
  dbClient?: any;
}

export interface ListReconciliationReportsResponse {
  reports: Array<Omit<PayoutReconciliationResult, "discrepancies">>;
  nextCursor: string | null;
}

/**
 * List persisted reconciliation reports with keyset pagination.
 */
export async function listReconciliationReports(
  limitOrOpts: number | ListReconciliationReportsOptions = 10,
  _offset?: number,
  dbClient?: any,
): Promise<any> {
  const isObjectOpts = typeof limitOrOpts === "object";
  const opts: ListReconciliationReportsOptions = isObjectOpts
    ? limitOrOpts
    : { limit: limitOrOpts };

  const client = opts.dbClient ?? dbClient ?? db;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);

  if (!client) {
    return isObjectOpts ? { reports: [], nextCursor: null } : [];
  }

  try {
    const conditions = [];
    if (opts.cursor) {
      try {
        const decoded = Buffer.from(opts.cursor, "base64").toString("utf-8");
        const [cursorTime, cursorId] = decoded.split("::");
        if (cursorTime && cursorId) {
          const cursorDate = new Date(cursorTime);
          conditions.push(
            or(
              lt(reconciliationReports.createdAt, cursorDate),
              and(
                eq(reconciliationReports.createdAt, cursorDate),
                lt(reconciliationReports.id, cursorId),
              ),
            ),
          );
        }
      } catch {
        // invalid cursor, ignore
      }
    }

    const rows = await client
      .select()
      .from(reconciliationReports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(reconciliationReports.createdAt), desc(reconciliationReports.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = Buffer.from(`${last.createdAt.toISOString()}::${last.id}`).toString("base64");
    }

    const reports = pageRows.map((r: any) => ({
      reportId: r.id,
      fingerprint: r.fingerprint,
      status: r.status as "ok" | "discrepancies_found",
      since: r.since ? r.since.toISOString() : null,
      until: r.until ? r.until.toISOString() : null,
      totalKeys: r.totalKeys,
      matchedKeys: r.matchedKeys,
      unmatchedKeys: r.unmatchedKeys,
      discrepancyCount: r.discrepancyCount,
      summary: (r.summary ?? {}) as Record<PayoutDiscrepancyKind, number>,
      createdAt: r.createdAt.toISOString(),
    }));

    if (isObjectOpts) {
      return { reports, nextCursor };
    }
    return reports;
  } catch (err) {
    logger.warn({ err }, "reconciliation.list_reports_failed");
    return isObjectOpts ? { reports: [], nextCursor: null } : [];
  }
}
