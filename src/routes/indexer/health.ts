/**
 * Indexer health router.
 *
 * GET /api/indexer/health
 *
 * Health probe for the indexer subsystem. Reports:
 *   1. External dependency status (database + Soroban RPC)
 *   2. Indexer liveness (cursor lag against the chain tip)
 *
 * Dependencies
 * ────────────
 *   • database   — Postgres (SELECT 1), stores cursor & events
 *   • sorobanRpc — Soroban RPC (getLatestLedger), provides chain tip
 *
 * Response shape
 * ──────────────
 * {
 *   "status":         "ok" | "degraded" | "down",
 *   "correlationId":  "<uuid>",
 *   "checkedAt":      "<ISO-8601>",
 *   "dependencies": {
 *     "database":   { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" },
 *     "sorobanRpc": { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" }
 *   },
 *   "data": {
 *     "status":    "ok" | "degraded" | "down",
 *     "cursor":    <n>,
 *     "chainTip":  <n> | null,
 *     "lag":       <n> | null,
 *     "maxLag":    <n>
 *   }
 * }
 *
 * Response codes
 * ──────────────
 * The endpoint always returns HTTP 200 so that uptime probes can scrape it
 * without tripping on non-2xx responses. Orchestrators should alert on the
 * `status` field instead.
 *
 *   top-level status:
 *     - "ok"       — all deps healthy + lag within threshold
 *     - "degraded" — lag exceeds threshold (indexer is behind)
 *     - "down"     — a dependency is unavailable or chain tip unreachable
 *
 * ETag
 * ────
 * Emits a strong `ETag` (see `../../middleware/etag`) derived from the
 * response body and honors `If-None-Match` with a `304 Not Modified`.
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in the `IndexerHealthRouterDeps` callbacks
 * so tests can substitute fully-controlled stubs.
 *
 * Security
 * ────────
 * No authentication required — the response contains no sensitive data.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { rpc } from "@stellar/stellar-sdk";
import { pool } from "../../db/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";
import { conditionalGet } from "../../middleware/etag";
import { securityHeaders } from "../../middleware/securityHeaders";
import { indexerService } from "../../services/indexerService";

// ─── Types ───────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface IndexerDependencyHealth {
  database: ProbeResult;
  sorobanRpc: ProbeResult;
}

export type IndexerStatus = "ok" | "degraded" | "down";

export interface IndexerLagData {
  status: IndexerStatus;
  cursor: number;
  chainTip: number | null;
  lag: number | null;
  maxLag: number;
}

export interface IndexerHealthResponse {
  status: IndexerStatus;
  correlationId: string;
  checkedAt: string;
  dependencies: IndexerDependencyHealth;
  data: IndexerLagData;
}

// ── Injectable dependency interface ──────────────────────────────────────

export type ProbeDatabaseFn = () => Promise<ProbeResult>;
export type ProbeSorobanRpcFn = () => Promise<ProbeResult>;

export interface IndexerHealthRouterDeps {
  probeDatabase?: ProbeDatabaseFn;
  probeSorobanRpc?: ProbeSorobanRpcFn;
}

// ─── Default probes ──────────────────────────────────────────────────────

async function defaultProbeDatabase(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Database unavailable",
    };
  }
}

async function defaultProbeSorobanRpc(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const server = new rpc.Server(env.SOROBAN_RPC_URL, {
      allowHttp: env.SOROBAN_RPC_URL.startsWith("http://"),
    });
    await server.getLatestLedger();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Soroban RPC unavailable",
    };
  }
}

// ─── Lag helpers ─────────────────────────────────────────────────────────

/** Maximum acceptable cursor lag (in ledgers) before the indexer is "degraded". */
const DEFAULT_MAX_LAG = 50;

function resolveMaxLag(): number {
  const raw = process.env.INDEXER_HEALTH_MAX_LAG;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_LAG;
}

function computeLagStatus(cursor: number, chainTip: number | null, maxLag: number): IndexerStatus {
  if (chainTip === null) return "down";
  const lag = Math.max(0, chainTip - cursor);
  return lag > maxLag ? "degraded" : "ok";
}

function computeOverallStatus(
  depStatus: IndexerDependencyHealth,
  lagStatus: IndexerStatus,
): IndexerStatus {
  if (depStatus.database.status === "down" || depStatus.sorobanRpc.status === "down") return "down";
  if (lagStatus === "down") return "down";
  if (lagStatus === "degraded") return "degraded";
  return "ok";
}

// ─── Router factory ──────────────────────────────────────────────────────

/**
 * Creates the /api/indexer/health router with injected dependencies.
 *
 * @param deps.probeDatabase    - Override the database probe (tests only).
 * @param deps.probeSorobanRpc  - Override the Soroban RPC probe (tests only).
 */
export function createIndexerHealthRouter(deps: IndexerHealthRouterDeps = {}): Router {
  const probeDb: ProbeDatabaseFn = deps.probeDatabase ?? defaultProbeDatabase;
  const probeRpc: ProbeSorobanRpcFn = deps.probeSorobanRpc ?? defaultProbeSorobanRpc;
  const router = Router();

  router.use(securityHeaders);

  router.get("/health", async (req, res, next) => {
    const reqId = getRequestId();
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      reqId ||
      randomUUID();
    const maxLag = resolveMaxLag();
    const requestStart = Date.now();

    try {
      // Run dependency probes and lag check in parallel
      const [database, sorobanRpc, cursor] = await Promise.all([
        probeDb(),
        probeRpc(),
        indexerService.getCursor(),
      ]);

      const dependencies: IndexerDependencyHealth = { database, sorobanRpc };

      let chainTip: number | null = null;
      try {
        chainTip = await indexerService.getChainTip();
      } catch (err) {
        // Cursor is readable but the chain tip is not — report "down" without
        // failing the whole probe so monitoring still gets the cursor value.
        logger.warn({ reqId, err }, "indexer_health_chain_tip_unavailable");
      }

      const lag = chainTip !== null ? Math.max(0, chainTip - cursor) : null;
      const lagStatus = computeLagStatus(cursor, chainTip, maxLag);
      const overallStatus = computeOverallStatus(dependencies, lagStatus);

      const lagData: IndexerLagData = {
        status: lagStatus,
        cursor,
        chainTip,
        lag,
        maxLag,
      };

      logger.info(
        {
          correlationId,
          reqId,
          status: overallStatus,
          lagStatus,
          cursor,
          chainTip,
          lag,
          maxLag,
          database: database.status,
          sorobanRpc: sorobanRpc.status,
          elapsedMs: Date.now() - requestStart,
        },
        "indexer_health_checked",
      );

      // ETag is derived only from the deterministic parts of the payload
      // (dependencies + lag data). Transient metadata like correlationId
      // and checkedAt are excluded so the ETag is stable across requests
      // with unchanged dependency/lag state.
      const etagPayload = { dependencies, data: lagData };

      const payload: IndexerHealthResponse = {
        status: overallStatus,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies,
        data: lagData,
      };

      if (conditionalGet(etagPayload, req, res)) return;
      return res.status(200).json(payload);
    } catch (err) {
      logger.error({ reqId, correlationId, err }, "indexer_health_failed");
      return next(err);
    }
  });

  return router;
}

export const indexerHealthRouter = createIndexerHealthRouter();
