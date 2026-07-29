/**
 * readinessService.ts
 *
 * Deep readiness probes used by GET /api/health/ready.
 *
 * Each probe is exported individually so they can be injected in tests without
 * touching real infrastructure. The top-level `performReadinessCheck` function
 * wires them together with the production dependencies.
 *
 * Probes
 * ──────
 *  • database    — lightweight SELECT 1 against the Postgres pool
 *  • sorobanRpc  — getLatestLedger() call to the Soroban RPC node
 *  • indexerLag  — compares indexer cursor to chain tip; fails when lag > threshold
 *  • queue       — Redis PING via the BullMQ connection
 *
 * Each probe has a 1-second timeout to prevent a single slow dependency from
 * blocking the readiness response. All four run in parallel via Promise.allSettled.
 */

import { env } from "../config/env";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { logger } from "../config/logger";
import * as sdk from "@stellar/stellar-sdk";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReadinessCheck {
  status: "pass" | "fail";
  /** Elapsed milliseconds for the probe. */
  durationMs: number;
  message: string;
}

export interface ReadinessStatus {
  db: ReadinessCheck;
  sorobanRpc: ReadinessCheck;
  indexerLag: ReadinessCheck;
  queue: ReadinessCheck;
}

export interface ReadinessResult {
  /** "ready" only when every probe passes. */
  status: "ready" | "unready";
  checks: ReadinessStatus;
}

// ── Injectable dependency interfaces ─────────────────────────────────────────

/** Minimal Drizzle DB surface the DB probe needs. */
export interface DbLike {
  execute(query: unknown): Promise<unknown>;
}

/** Minimal Redis surface the queue probe needs. */
export interface RedisLike {
  ping(): Promise<string>;
}

// ── Timeout helper ────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 1_000;

function withProbeTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Probe timed out")),
        PROBE_TIMEOUT_MS,
      ),
    ),
  ]);
}

// ── Individual probes ─────────────────────────────────────────────────────────

/**
 * Probe Postgres with a lightweight SELECT 1.
 *
 * @param db - Drizzle DB instance (or compatible test stub).
 */
export async function checkDatabase(db: DbLike): Promise<ReadinessCheck> {
  const start = Date.now();
  try {
    await withProbeTimeout(db.execute(sql`SELECT 1`));
    return {
      status: "pass",
      durationMs: Date.now() - start,
      message: "Database connection healthy",
    };
  } catch (error) {
    logger.error({ error }, "readiness_db_check_failed");
    return {
      status: "fail",
      durationMs: Date.now() - start,
      message:
        error instanceof Error ? error.message : "Database connection failed",
    };
  }
}

/**
 * Probe the Soroban RPC node by calling getLatestLedger.
 */
export async function checkSorobanRpc(): Promise<ReadinessCheck> {
  const start = Date.now();
  try {
    const client = new sdk.SorobanRpc.Server(env.SOROBAN_RPC_URL, {
      allowHttp: env.STELLAR_NETWORK === "testnet",
    });
    await withProbeTimeout(client.getLatestLedger());
    return {
      status: "pass",
      durationMs: Date.now() - start,
      message: "Soroban RPC healthy",
    };
  } catch (error) {
    logger.error({ error }, "readiness_rpc_check_failed");
    return {
      status: "fail",
      durationMs: Date.now() - start,
      message:
        error instanceof Error ? error.message : "Soroban RPC failed",
    };
  }
}

/**
 * Probe indexer lag by comparing the cursor in `indexer_cursor` to the chain
 * tip returned by Soroban RPC. Fails when the absolute lag exceeds
 * `READINESS_MAX_LAG_LEDGERS` (env, default 200).
 *
 * The SQL query is intentionally simple — it reads the `indexer_cursor` row
 * and calls getLatestLedger() in parallel rather than attempting the complex
 * ledger-entry query that requires a live Soroban contract state.
 *
 * @param db - Drizzle DB instance (or compatible test stub).
 */
export async function checkIndexerLag(db: DbLike): Promise<ReadinessCheck> {
  const start = Date.now();
  const maxLag = Number(process.env.READINESS_MAX_LAG_LEDGERS) || 200;

  try {
    // Fetch both the cursor and the chain tip in parallel.
    const rpcClient = new sdk.SorobanRpc.Server(env.SOROBAN_RPC_URL, {
      allowHttp: env.STELLAR_NETWORK === "testnet",
    });

    const [cursorResult, ledgerResult] = await withProbeTimeout(
      Promise.all([
        (db as NodePgDatabase).execute(
          sql`SELECT last_ledger FROM indexer_cursor WHERE id = 1 LIMIT 1`,
        ),
        rpcClient.getLatestLedger(),
      ]),
    );

    // `cursorResult` is a Drizzle result with a `rows` array.
    const rows = (cursorResult as unknown as { rows: Array<{ last_ledger: number }> }).rows;
    const lastIndexed = rows[0]?.last_ledger ?? null;
    const chainTip = ledgerResult.sequence;

    if (lastIndexed === null) {
      return {
        status: "fail",
        durationMs: Date.now() - start,
        message: "Indexer cursor not found — indexer may not have started",
      };
    }

    const lag = Math.max(0, chainTip - lastIndexed);

    if (lag <= maxLag) {
      return {
        status: "pass",
        durationMs: Date.now() - start,
        message: `Indexer lag healthy: ${lag} ≤ ${maxLag} ledgers`,
      };
    }

    return {
      status: "fail",
      durationMs: Date.now() - start,
      message: `Indexer lag too high: ${lag} > ${maxLag} ledgers`,
    };
  } catch (error) {
    logger.error({ error }, "readiness_indexer_lag_check_failed");
    return {
      status: "fail",
      durationMs: Date.now() - start,
      message:
        error instanceof Error ? error.message : "Indexer lag check failed",
    };
  }
}

/**
 * Probe the BullMQ Redis connection with a PING.
 *
 * @param redis - IORedis-compatible connection (or compatible test stub).
 */
export async function checkQueue(redis: RedisLike): Promise<ReadinessCheck> {
  const start = Date.now();
  try {
    const pong = await withProbeTimeout(redis.ping());
    if (pong !== "PONG") {
      return {
        status: "fail",
        durationMs: Date.now() - start,
        message: `Unexpected Redis PING response: ${pong}`,
      };
    }
    return {
      status: "pass",
      durationMs: Date.now() - start,
      message: "Queue (Redis) healthy",
    };
  } catch (error) {
    logger.error({ error }, "readiness_queue_check_failed");
    return {
      status: "fail",
      durationMs: Date.now() - start,
      message:
        error instanceof Error ? error.message : "Queue (Redis) connection failed",
    };
  }
}

// ── Top-level orchestrator ────────────────────────────────────────────────────

/**
 * Run all four readiness probes in parallel and return a consolidated result.
 *
 * A failed `Promise.allSettled` branch (i.e. an unexpected throw that bypasses
 * the probe's own try/catch) is mapped to a generic "fail" check so the
 * overall response always has a consistent shape.
 *
 * @param db    - Drizzle DB instance wired to the Postgres pool.
 * @param redis - IORedis connection used by BullMQ.
 */
export async function performReadinessCheck(
  db: DbLike,
  redis: RedisLike,
): Promise<ReadinessResult> {
  const [dbResult, rpcResult, lagResult, queueResult] =
    await Promise.allSettled([
      checkDatabase(db),
      checkSorobanRpc(),
      checkIndexerLag(db),
      checkQueue(redis),
    ]);

  const now = Date.now();

  function unwrap(
    settled: PromiseSettledResult<ReadinessCheck>,
    fallbackMessage: string,
  ): ReadinessCheck {
    if (settled.status === "fulfilled") return settled.value;
    return { status: "fail", durationMs: now, message: fallbackMessage };
  }

  const checks: ReadinessStatus = {
    db: unwrap(dbResult, "Database check threw unexpectedly"),
    sorobanRpc: unwrap(rpcResult, "Soroban RPC check threw unexpectedly"),
    indexerLag: unwrap(lagResult, "Indexer lag check threw unexpectedly"),
    queue: unwrap(queueResult, "Queue check threw unexpectedly"),
  };

  const ready = Object.values(checks).every((c) => c.status === "pass");

  return {
    status: ready ? "ready" : "unready",
    checks,
  };
}
