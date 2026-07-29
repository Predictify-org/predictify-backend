/**
 * adminHealthService.ts
 *
 * Collects detailed runtime health data for the admin health endpoint.
 *
 * Three sub-checks run in parallel, each with an independent timeout:
 *  1. dbPool   — DB connection pool stats + a lightweight liveness query
 *  2. indexer  — last indexed ledger from indexer_cursor and chain tip from RPC
 *  3. rpc      — Soroban RPC reachability and latest ledger sequence
 *
 * All dependencies are injected so the service is fully testable without a
 * real database or network connection.
 */

// import type { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "degraded" | "error";

export interface DbPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface DbPoolCheck {
  status: CheckStatus;
  latencyMs: number;
  stats: DbPoolStats;
  error?: string;
}

export interface IndexerCheck {
  status: CheckStatus;
  latencyMs: number;
  /** Last ledger stored in indexer_cursor, null if table is empty. */
  lastIndexedLedger: number | null;
  /** Latest ledger reported by Soroban RPC, null if RPC is unreachable. */
  chainTip: number | null;
  /** Absolute lag in ledgers (chainTip - lastIndexedLedger). null when either value is unavailable. */
  lagLedgers: number | null;
  error?: string;
}

export interface RpcCheck {
  status: CheckStatus;
  latencyMs: number;
  /** Latest ledger sequence number returned by the RPC. */
  latestLedger: number | null;
  error?: string;
}

export interface AdminHealthDetail {
  dbPool: DbPoolCheck;
  indexer: IndexerCheck;
  rpc: RpcCheck;
  /** ISO timestamp of when the snapshot was taken. */
  checkedAt: string;
}

// ── Injectable dependency interfaces ─────────────────────────────────────────

/** Minimal pg Pool surface we need. */
export interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

/** Minimal Soroban RPC surface. */
export interface RpcLike {
  getLatestLedger(): Promise<{ sequence: number }>;
}

// ── Timeout helper ────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS),
    ),
  ]);
}

// ── Sub-checks ────────────────────────────────────────────────────────────────

async function checkDbPool(pool: PoolLike): Promise<DbPoolCheck> {
  const start = Date.now();
  const stats: DbPoolStats = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };

  try {
    await pool.query("SELECT 1");
    return { status: "ok", latencyMs: Date.now() - start, stats };
  } catch (err) {
    logger.warn({ err }, "admin_health_db_check_failed");
    return {
      status: "error",
      latencyMs: Date.now() - start,
      stats,
      error: err instanceof Error ? err.message : "DB query failed",
    };
  }
}

async function checkIndexer(
  pool: PoolLike,
  rpc: RpcLike,
): Promise<IndexerCheck> {
  const start = Date.now();

  let lastIndexedLedger: number | null = null;
  let chainTip: number | null = null;

  try {
    const [cursorResult, ledgerResult] = await Promise.all([
      pool.query<{ last_ledger: number }>(
        "SELECT last_ledger FROM indexer_cursor WHERE id = 1 LIMIT 1",
      ),
      rpc.getLatestLedger(),
    ]);

    lastIndexedLedger = cursorResult.rows[0]?.last_ledger ?? null;
    chainTip = ledgerResult.sequence;

    const lagLedgers =
      lastIndexedLedger !== null && chainTip !== null
        ? Math.max(0, chainTip - lastIndexedLedger)
        : null;

    const threshold = env.INDEXER_LAG_ALERT_THRESHOLD;
    const status: CheckStatus =
      lagLedgers === null
        ? "degraded"
        : lagLedgers > threshold
          ? "degraded"
          : "ok";

    return {
      status,
      latencyMs: Date.now() - start,
      lastIndexedLedger,
      chainTip,
      lagLedgers,
    };
  } catch (err) {
    logger.warn({ err }, "admin_health_indexer_check_failed");
    return {
      status: "error",
      latencyMs: Date.now() - start,
      lastIndexedLedger,
      chainTip,
      lagLedgers: null,
      error: err instanceof Error ? err.message : "Indexer check failed",
    };
  }
}

async function checkRpc(rpc: RpcLike): Promise<RpcCheck> {
  const start = Date.now();
  try {
    const { sequence } = await rpc.getLatestLedger();
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      latestLedger: sequence,
    };
  } catch (err) {
    logger.warn({ err }, "admin_health_rpc_check_failed");
    return {
      status: "error",
      latencyMs: Date.now() - start,
      latestLedger: null,
      error: err instanceof Error ? err.message : "RPC check failed",
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const TIMEOUT_FALLBACK_DB: DbPoolCheck = {
  status: "error",
  latencyMs: PROBE_TIMEOUT_MS,
  stats: { total: 0, idle: 0, waiting: 0 },
  error: "Probe timed out",
};

const TIMEOUT_FALLBACK_INDEXER: IndexerCheck = {
  status: "error",
  latencyMs: PROBE_TIMEOUT_MS,
  lastIndexedLedger: null,
  chainTip: null,
  lagLedgers: null,
  error: "Probe timed out",
};

const TIMEOUT_FALLBACK_RPC: RpcCheck = {
  status: "error",
  latencyMs: PROBE_TIMEOUT_MS,
  latestLedger: null,
  error: "Probe timed out",
};

/**
 * Collect all health details in parallel.
 *
 * Each sub-check has an independent 5 s timeout — one slow dependency cannot
 * block the others.
 *
 * @param pool - pg Pool (or compatible test stub)
 * @param rpc  - Soroban RPC client (or compatible test stub)
 */
export async function getAdminHealthDetail(
  pool: PoolLike,
  rpc: RpcLike,
): Promise<AdminHealthDetail> {
  const [dbPool, indexer, rpc_] = await Promise.all([
    withTimeout(checkDbPool(pool), TIMEOUT_FALLBACK_DB),
    withTimeout(checkIndexer(pool, rpc), TIMEOUT_FALLBACK_INDEXER),
    withTimeout(checkRpc(rpc), TIMEOUT_FALLBACK_RPC),
  ]);

  return {
    dbPool,
    indexer,
    rpc: rpc_,
    checkedAt: new Date().toISOString(),
  };
}
