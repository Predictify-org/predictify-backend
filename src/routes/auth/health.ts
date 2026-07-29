/**
 * auth/health.ts
 *
 * GET /api/auth/health
 *
 * Health probe for /api/auth dependencies.
 * Checks the database connection since auth operations (challenge, verify,
 * refresh) all depend on Postgres for storing challenges and refresh tokens.
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
 * Response codes
 * ──────────────
 *  200 OK          — database probe passed
 *  503 Unavailable — database probe failed
 *
 * Security
 * ────────
 * No authentication required — the response contains no sensitive data.
 */

import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { pool } from "../../db/client";
import { logger } from "../../config/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface AuthHealth {
  status: ProbeStatus;
  correlationId: string;
  checkedAt: string;
  dependencies: {
    database: ProbeResult;
  };
}

// ── Probe ────────────────────────────────────────────────────────────────────

async function probeDatabase(): Promise<ProbeResult> {
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

// ── Router ───────────────────────────────────────────────────────────────────

export const authHealthRouter = Router();

/**
 * GET /
 *
 * Probes the database and returns an auth-specific health snapshot.
 */
authHealthRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const database = await probeDatabase();
      const status: ProbeStatus = database.status === "ok" ? "ok" : "down";
      const httpStatus = status === "ok" ? 200 : 503;

      logger.info(
        {
          correlationId,
          status,
          httpStatus,
          elapsedMs: Date.now() - requestStart,
          database: database.status,
        },
        "auth_health_check_complete",
      );

      res.status(httpStatus).json({
        status,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies: { database },
      });
    } catch (err) {
      logger.error(
        { correlationId, err, elapsedMs: Date.now() - requestStart },
        "auth_health_probe_threw",
      );
      next(err);
    }
  },
);
