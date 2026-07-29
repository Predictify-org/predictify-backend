/**
 * admin/db/vacuum.ts
 *
 * POST /api/admin/db/vacuum
 *
 * Triggers PostgreSQL VACUUM on selected tables to reclaim storage and
 * improve query performance. Supports optional ANALYZE to update planner
 * statistics after vacuuming.
 *
 * Security:
 *  - Requires a valid admin JWT (role: "admin") via requireAdmin.
 *  - Rate-limited to 30 requests per minute per admin token.
 *  - Table names are validated against a strict allowlist — no raw SQL
 *    interpolation of user input.
 *  - Returns the project's standard error envelope on failure.
 *  - Echoes the X-Request-Id so the client can correlate logs.
 *
 * HTTP status codes:
 *  - 200 OK            vacuum completed (check vacuumResults for per-table status)
 *  - 400 Bad Request   validation error
 *  - 403 Forbidden     missing/invalid/non-admin JWT
 *  - 429 Too Many Requests
 *
 * Does NOT write to the audit log — this is a maintenance operation.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import type { Pool } from "pg";
import { pool } from "../../../db/client";

// ── Allowlist ──────────────────────────────────────────────────────────────

const ALLOWED_TABLES = [
  "users",
  "auth_challenges",
  "refresh_tokens",
  "webhook_subscriptions",
  "webhook_deliveries",
  "webhook_deliveries_dlq",
  "markets",
  "market_audit_log",
  "predictions",
  "fraud_flags",
  "claims",
  "disputes",
  "admin_audit_log",
  "indexer_cursor",
  "contract_events",
  "indexer_events",
  "idempotency_records",
  "notification_preferences",
  "audit_logs",
  "feature_flags",
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];

function isAllowedTable(name: string): name is AllowedTable {
  return (ALLOWED_TABLES as readonly string[]).includes(name);
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface AdminDbVacuumRouterOptions {
  /** Requests per minute per admin token. Default: 30 */
  rateLimitPerMinute?: number;
}

export interface VacuumResult {
  tables: string[];
  vacuumingTimeMs: number;
  analyzingTimeMs: number;
  vacuumResults: Array<{
    table: string;
    status: "success" | "failed";
    message?: string;
  }>;
}

// ── Validation schema ──────────────────────────────────────────────────────

const vacuumBodySchema = z
  .object({
    tables: z
      .array(z.string())
      .min(1, "At least one table must be specified")
      .max(10, "Cannot specify more than 10 tables at once")
      .optional(),
    analyze: z.boolean().default(false),
  })
  .strict();

// ── Default tables ─────────────────────────────────────────────────────────

const DEFAULT_TABLES: AllowedTable[] = [
  "idempotency_records",
  "webhook_deliveries",
  "webhook_deliveries_dlq",
  "contract_events",
  "indexer_events",
  "audit_logs",
];

// ── Router factory ─────────────────────────────────────────────────────────

export function createAdminDbVacuumRouter(
  opts: AdminDbVacuumRouterOptions = {},
): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 30;

  // ── Rate limiter ──────────────────────────────────────────────────────────
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ??
        req.ip ??
        "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ───────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── POST / ────────────────────────────────────────────────────────────────
  router.post("/", async (req, res, next) => {
    const requestId = getRequestId();

    try {
      const parsed = vacuumBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              parsed.error.issues[0]?.message ?? "invalid request body",
            details: parsed.error.issues,
            requestId,
          },
        });
        return;
      }

      const { tables, analyze } = parsed.data;

      // Validate table names against the allowlist
      const targetNames = tables ?? DEFAULT_TABLES;
      const invalid = targetNames.filter((t) => !isAllowedTable(t));
      if (invalid.length > 0) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: `Invalid table name(s): ${invalid.join(", ")}`,
            requestId,
          },
        });
        return;
      }

      const result = await executeVacuum(pool, targetNames, { analyze }, requestId ?? "");

      logger.info(
        {
          event: "db_vacuum_completed",
          requestId,
          adminAddress: req.adminAddress,
          tables: targetNames,
          analyze,
          vacuumingTimeMs: result.vacuumingTimeMs,
          analyzingTimeMs: result.analyzingTimeMs,
        },
        "Database vacuum completed",
      );

      res.json({ data: result });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Default export wired into src/index.ts
export const adminDbVacuumRouter = createAdminDbVacuumRouter();

// ── Execute vacuum ─────────────────────────────────────────────────────────

/**
 * Run VACUUM (and optionally ANALYZE) on each table in the list.
 *
 * Errors per table are caught and reported individually so one failing
 * table does not abort the rest.
 */
export async function executeVacuum(
  poolInstance: Pool,
  tables: string[],
  options: { analyze: boolean },
  requestId: string,
): Promise<VacuumResult> {
  const vacuumResults: VacuumResult["vacuumResults"] = [];

  let vacuumTime = 0;
  let analyzeTime = 0;

  for (const table of tables) {
    // VACUUM must not run inside a transaction block. pool.query() checks
    // out a fresh client for each call, so no transaction is active.
    const t0 = Date.now();
    try {
      await poolInstance.query(`VACUUM ${table}`);
      vacuumTime += Date.now() - t0;

      if (options.analyze) {
        const a0 = Date.now();
        await poolInstance.query(`ANALYZE ${table}`);
        analyzeTime += Date.now() - a0;
      }

      vacuumResults.push({
        table,
        status: "success",
      });
    } catch (err) {
      vacuumTime += Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { table, error: msg, requestId },
        "VACUUM failed for table",
      );
      vacuumResults.push({
        table,
        status: "failed",
        message: msg,
      });
    }
  }

  return {
    tables,
    vacuumingTimeMs: vacuumTime,
    analyzingTimeMs: analyzeTime,
    vacuumResults,
  };
}
