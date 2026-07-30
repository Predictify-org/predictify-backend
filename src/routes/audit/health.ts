/**
 * audit/health.ts
 *
 * GET /api/audit/health
 *
 * Health probe endpoint listing /api/audit's external dependencies with status.
 * The audit subsystem relies on Postgres for storing and querying audit logs.
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
 *     "database": { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" }
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
 * All external I/O is encapsulated in the `AuditHealthRouterDeps` callbacks
 * so tests can substitute fully-controlled stubs without touching real
 * infrastructure.
 */

import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { pool } from "../../db/client";
import { logger } from "../../config/logger";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface AuditDependencyHealth {
  database: ProbeResult;
}

// ── Injectable dependency interface ────────────────────────────────────────────

export type ProbeDatabaseFn = () => Promise<ProbeResult>;

export interface AuditHealthRouterDeps {
  /** Override the database probe (tests only). Defaults to `defaultProbeDatabase`. */
  probeDatabase?: ProbeDatabaseFn;
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

// ── Router factory ─────────────────────────────────────────────────────────────

/**
 * Creates the /api/audit/health router with injected dependencies.
 *
 * @param deps.probeDatabase - Override the database probe (tests only).
 */
export function createAuditHealthRouter(deps: AuditHealthRouterDeps = {}): Router {
  const probeDb: ProbeDatabaseFn = deps.probeDatabase ?? defaultProbeDatabase;
  const router = Router();

  /**
   * GET /
   *
   * Probes the database and returns an audit-specific health snapshot.
   */
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const database = await probeDb();
      const allOk = database.status === "ok";
      const status: ProbeStatus = allOk ? "ok" : "down";
      const httpStatus = allOk ? 200 : 503;

      const dependencies: AuditDependencyHealth = { database };

      logger.info(
        {
          correlationId,
          status,
          httpStatus,
          elapsedMs: Date.now() - requestStart,
          database: database.status,
        },
        "audit_health_check_complete",
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
        "audit_health_probe_threw",
      );
      next(err);
    }
  });

  return router;
}

// ── Default export ─────────────────────────────────────────────────────────────

/** Production router instance wired into src/index.ts. */
export const auditHealthRouter = createAuditHealthRouter();
