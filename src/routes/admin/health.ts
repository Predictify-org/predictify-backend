/**
 * admin/health.ts
 *
 * Dependency probe and detailed health for the /api/admin subsystem.
 *
 * GET /api/admin/health
 *   Standard dependency probe listing /api/admin's external dependencies
 *   with status. No authentication required — the response contains no
 *   sensitive data.
 *
 * GET /api/admin/health/detail
 *   Detailed runtime health including DB pool stats, indexer cursor, and
 *   Soroban RPC status. Requires a valid admin JWT (role: "admin").
 *
 * Admin dependencies
 * ──────────────────
 *   • database   — Postgres (SELECT 1), stores all admin data
 *   • sorobanRpc — Soroban RPC (getLatestLedger), needed for force-resolve
 *                  and reconciliation
 *   • queue      — Redis (PING), used by webhook DLQ and circuit breaker
 *
 * Response codes (GET /)
 * ──────────────────────
 *   200 OK           — all dependencies are healthy
 *   503 Unavailable  — at least one dependency is down
 *
 * Security
 * ────────
 *   GET /            — No authentication required
 *   GET /detail      — Requires admin JWT + rate-limited to 30 rpm
 *   In production, restrict / at the infrastructure level if desired.
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in the callbacks so tests can substitute
 * fully-controlled stubs without touching real infrastructure.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { rateLimit } from "express-rate-limit";
import { rpc as stellarRpc } from "@stellar/stellar-sdk";
import { requireAdmin } from "../../middleware/requireAdmin";
import { pool } from "../../db/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { redisConnection } from "../../queue";
import { getAdminHealthDetail, type CheckStatus } from "../../services/adminHealthService";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface AdminDependencyHealth {
  database: ProbeResult;
  sorobanRpc: ProbeResult;
  queue: ProbeResult;
}

// ── Injectable dependency interface ────────────────────────────────────────────

export type ProbeDatabaseFn = () => Promise<ProbeResult>;
export type ProbeSorobanRpcFn = () => Promise<ProbeResult>;
export type ProbeQueueFn = () => Promise<ProbeResult>;

export interface AdminHealthDeps {
  /** Override the database probe (tests only). Defaults to `defaultProbeDatabase`. */
  probeDatabase?: ProbeDatabaseFn;
  /** Override the Soroban RPC probe (tests only). Defaults to `defaultProbeSorobanRpc`. */
  probeSorobanRpc?: ProbeSorobanRpcFn;
  /** Override the Redis queue probe (tests only). Defaults to `defaultProbeQueue`. */
  probeQueue?: ProbeQueueFn;
}

export interface AdminHealthRouterOptions {
  /** Requests per minute per admin token for /detail. Default: 30 */
  rateLimitPerMinute?: number;
  /** Override probe functions for the GET / endpoint (tests only). */
  probes?: AdminHealthDeps;
}

// ── Default probes ─────────────────────────────────────────────────────────────

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
    const server = new stellarRpc.Server(env.SOROBAN_RPC_URL, {
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

async function defaultProbeQueue(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await redisConnection.ping();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Webhook queue unavailable",
    };
  }
}

/** Derive the HTTP status from the collection of check statuses. */
function toHttpStatus(checks: CheckStatus[]): 200 | 207 {
  return checks.every((s) => s === "ok") ? 200 : 207;
}

export function createAdminHealthRouter(opts: AdminHealthRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 30;
  const probeDb: ProbeDatabaseFn = opts.probes?.probeDatabase ?? defaultProbeDatabase;
  const probeRpc: ProbeSorobanRpcFn = opts.probes?.probeSorobanRpc ?? defaultProbeSorobanRpc;
  const probeQ: ProbeQueueFn = opts.probes?.probeQueue ?? defaultProbeQueue;

  // ── GET / (dependency probe — no auth required) ─────────────────────────
  router.get("/", async (req, res, next) => {
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const [database, sorobanRpc, queue] = await Promise.all([
        probeDb(),
        probeRpc(),
        probeQ(),
      ]);

      const dependencies: AdminDependencyHealth = { database, sorobanRpc, queue };
      const allOk = database.status === "ok" && sorobanRpc.status === "ok" && queue.status === "ok";
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
          queue: queue.status,
        },
        "admin_health_check_complete",
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
        "admin_health_probe_threw",
      );
      next(err);
    }
  });

  // ── Rate limiter (applies only to /detail) ──────────────────────────────
  const detailRouter = Router();
  detailRouter.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ─────────────────────────────────────────────────────────
  detailRouter.use(requireAdmin);

  // ── GET /detail ─────────────────────────────────────────────────────────
  detailRouter.get("/detail", async (_req, res, next) => {
    try {
      const rpcServer = new stellarRpc.Server(env.SOROBAN_RPC_URL, {
        allowHttp: env.SOROBAN_RPC_URL.startsWith("http://"),
      });

      const detail = await getAdminHealthDetail(pool, rpcServer);

      const httpStatus = toHttpStatus([
        detail.dbPool.status,
        detail.indexer.status,
        detail.rpc.status,
      ]);

      res.status(httpStatus).json(detail);
    } catch (e) {
      next(e);
    }
  });

  router.use(detailRouter);

  return router;
}

// Default export wired into src/index.ts
export const adminHealthRouter = createAdminHealthRouter();
