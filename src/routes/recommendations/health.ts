/**
 * recommendations/health.ts
 *
 * GET /api/recommendations/health
 *
 * Health probe endpoint for the /api/recommendations subsystem. Reports the
 * status of every external dependency that the recommendations pipeline relies
 * on:
 *
 *   • database   — Postgres (SELECT 1), stores market + prediction data that
 *                  powers personalised market recommendations.
 *   • sorobanRpc — Soroban RPC (getLatestLedger), used to verify that the
 *                  on-chain market index that recommendations are built on top
 *                  of is reachable and current.
 *
 * This endpoint is intentionally separate from the broader probes:
 *   • GET /health                  — process liveness (no I/O)
 *   • GET /healthz/dependencies    — shallow cached probe (5 s TTL)
 *   • GET /api/health/ready        — deep readiness for orchestrators
 *   • GET /api/predictions/health  — predictions-subsystem probe
 *   • GET /api/recommendations/health — this file; recommendations-specific
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
 * The response is NOT cached. Callers that need caching should add a cache
 * layer in front of this endpoint.
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in the `RecommendationsHealthRouterDeps`
 * callbacks so tests can substitute fully-controlled stubs without touching
 * real infrastructure.
 */

import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { rpc } from "@stellar/stellar-sdk";
import { pool } from "../../db/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface RecommendationsDependencyHealth {
  database: ProbeResult;
  sorobanRpc: ProbeResult;
}

// ── Default probes ────────────────────────────────────────────────────────────

/**
 * Probes Postgres with a lightweight `SELECT 1` round-trip.
 * Returns `{ status: "ok" }` on success and `{ status: "down" }` on failure.
 */
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

/**
 * Probes the Soroban RPC server by calling `getLatestLedger`.
 * Returns `{ status: "ok" }` on success and `{ status: "down" }` on failure.
 */
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

// ── Injectable dependency interface ──────────────────────────────────────────

export type ProbeDatabaseFn = () => Promise<ProbeResult>;
export type ProbeSorobanRpcFn = () => Promise<ProbeResult>;

export interface RecommendationsHealthRouterDeps {
  /**
   * Override the database probe (tests only).
   * Defaults to a `SELECT 1` probe against the production Postgres pool.
   */
  probeDatabase?: ProbeDatabaseFn;
  /**
   * Override the Soroban RPC probe (tests only).
   * Defaults to a `getLatestLedger` call against the configured Soroban RPC
   * endpoint.
   */
  probeSorobanRpc?: ProbeSorobanRpcFn;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the /api/recommendations/health router with injectable probe
 * callbacks.
 *
 * @param deps.probeDatabase    - Override the database probe (tests only).
 *                                Defaults to `defaultProbeDatabase`.
 * @param deps.probeSorobanRpc  - Override the Soroban RPC probe (tests only).
 *                                Defaults to `defaultProbeSorobanRpc`.
 */
export function createRecommendationsHealthRouter(
  deps: RecommendationsHealthRouterDeps = {},
): Router {
  const probeDb: ProbeDatabaseFn = deps.probeDatabase ?? defaultProbeDatabase;
  const probeRpc: ProbeSorobanRpcFn =
    deps.probeSorobanRpc ?? defaultProbeSorobanRpc;

  const router = Router();

  /**
   * GET /health
   *
   * Runs the database and Soroban RPC probes in parallel and returns the
   * recommendations-subsystem health snapshot.
   */
  router.get(
    "/health",
    async (req: Request, res: Response, next: NextFunction) => {
      const correlationId =
        ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
        randomUUID();

      const requestStart = Date.now();

      try {
        // Run both probes concurrently; a single slow probe does not block the
        // other.
        const [database, sorobanRpc] = await Promise.all([
          probeDb(),
          probeRpc(),
        ]);

        const dependencies: RecommendationsDependencyHealth = {
          database,
          sorobanRpc,
        };

        const allOk =
          database.status === "ok" && sorobanRpc.status === "ok";
        const status: ProbeStatus = allOk ? "ok" : "down";
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
          "recommendations_health_check_complete",
        );

        res.status(httpStatus).json({
          status,
          correlationId,
          checkedAt: new Date().toISOString(),
          dependencies,
        });
      } catch (err) {
        logger.error(
          {
            correlationId,
            err,
            elapsedMs: Date.now() - requestStart,
          },
          "recommendations_health_probe_threw",
        );
        next(err);
      }
    },
  );

  return router;
}

// ── Default export ────────────────────────────────────────────────────────────

/** Production router instance wired into src/index.ts. */
export const recommendationsHealthRouter = createRecommendationsHealthRouter();
