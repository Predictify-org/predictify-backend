/**
 * predictions/health.ts
 *
 * GET /api/predictions/health
 *
 * Health probe endpoint listing /api/predictions's external dependencies
 * with status.  Predictions rely on:
 *   • database   — Postgres (SELECT 1), stores prediction + market data
 *   • sorobanRpc — Soroban RPC (getLatestLedger), needed for claim flow
 *
 * Response codes
 * ──────────────
 *   200 OK           — all dependencies are healthy
 *   503 Unavailable  — at least one dependency is down
 *
 * Response shape
 * ──────────────
 * {
 *   "status":        "ok" | "down",
 *   "correlationId": "<uuid>",
 *   "checkedAt":     "<ISO-8601>",
 *   "dependencies": {
 *     "database":   { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" },
 *     "sorobanRpc": { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" }
 *   }
 * }
 *
 * Security
 * ────────
 * No authentication required — the response contains no sensitive data.
 * In production, restrict access at the infrastructure level (internal ALB,
 * VPC-only routing, etc.).
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in the `PredictionsHealthRouterDeps`
 * callbacks so tests can substitute fully-controlled stubs without touching
 * real infrastructure.
 */

import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { rpc } from "@stellar/stellar-sdk";
import { pool } from "../../db/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

// ─── Types ───────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface PredictionsDependencyHealth {
  database: ProbeResult;
  sorobanRpc: ProbeResult;
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

// ── Injectable dependency interface ──────────────────────────────────────

export type ProbeDatabaseFn = () => Promise<ProbeResult>;
export type ProbeSorobanRpcFn = () => Promise<ProbeResult>;

export interface PredictionsHealthRouterDeps {
  probeDatabase?: ProbeDatabaseFn;
  probeSorobanRpc?: ProbeSorobanRpcFn;
}

// ─── Router factory ──────────────────────────────────────────────────────

/**
 * Creates the /api/predictions/health router.
 *
 * @param deps.probeDatabase    - Override the database probe (tests only).
 *                                Defaults to `defaultProbeDatabase`.
 * @param deps.probeSorobanRpc  - Override the Soroban RPC probe (tests only).
 *                                Defaults to `defaultProbeSorobanRpc`.
 */
export function createPredictionsHealthRouter(
  deps: PredictionsHealthRouterDeps = {},
): Router {
  const probeDb: ProbeDatabaseFn = deps.probeDatabase ?? defaultProbeDatabase;
  const probeRpc: ProbeSorobanRpcFn = deps.probeSorobanRpc ?? defaultProbeSorobanRpc;
  const router = Router();

  /**
   * GET /health
   *
   * Runs the database and Soroban RPC probes in parallel and returns the
   * health snapshot.
   */
  router.get("/health", async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const [database, sorobanRpc] = await Promise.all([
        probeDb(),
        probeRpc(),
      ]);

      const dependencies: PredictionsDependencyHealth = { database, sorobanRpc };

      const allOk = database.status === "ok" && sorobanRpc.status === "ok";
      const status = allOk ? "ok" : "down";
      const httpStatus = allOk ? 200 : 503;

      logger.info(
        {
          correlationId,
          status,
          httpStatus,
          elapsedMs: Date.now() - requestStart,
          database: database.status,
          sorobanRpc: sorobanRpc.status,
        },
        "predictions_health_check_complete",
      );

      res.status(httpStatus).json({
        status,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies,
      });
    } catch (err) {
      logger.error(
        { correlationId, err, elapsedMs: Date.now() - requestStart },
        "predictions_health_probe_threw",
      );
      next(err);
    }
  });

  return router;
}

// ── Default export ────────────────────────────────────────────────────────

/** Production router instance. */
export const predictionsHealthRouter = createPredictionsHealthRouter();
