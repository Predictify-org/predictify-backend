import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { logger } from "../config/logger";
import { markets, predictions, users } from "../db/schema";
import { createAuditLog } from "./auditService";

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

export async function performReconciliation(): Promise<{
  skipped: true;
  reason: string;
}> {
  logger.info(
    "Global reconciliation run skipped; use admin market reconciliation instead",
  );
  return {
    skipped: true,
    reason: "Use GET /api/admin/recon/markets/:id for targeted reconciliation.",
  };
}

export async function getReconciliationReport(): Promise<null> {
  return null;
}

export async function listReconciliationReports(): Promise<[]> {
  return [];
}
