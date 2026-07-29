import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import { getPool } from "../../../db/client";

export interface AdminDbExplainRouterOptions {
  /** Requests per minute per admin token. Default: 60 */
  rateLimitPerMinute?: number;
}

// Predefined allowlisted query templates
export const ALLOWLISTED_QUERIES: Record<string, { sql: string; paramSchema: z.ZodTypeAny }> = {
  search_markets_fts: {
    sql: `
      SELECT id, question, status, resolution_outcome, resolution_time, winning_outcome, archived
      FROM markets
      WHERE archived = false
        AND (
          to_tsvector('english', coalesce(question, '')) @@ plainto_tsquery('english', $1)
        )
      LIMIT $2 OFFSET $3
    `,
    paramSchema: z.tuple([
      z.string(),
      z.number().int().min(1).max(100),
      z.number().int().min(0)
    ]),
  },
  search_markets_trigram: {
    sql: `
      SELECT id, question, status, resolution_outcome, resolution_time, winning_outcome, archived
      FROM markets
      WHERE archived = false
        AND (question % $1 OR question ILIKE $2)
      LIMIT $3 OFFSET $4
    `,
    paramSchema: z.tuple([
      z.string(),
      z.string(),
      z.number().int().min(1).max(100),
      z.number().int().min(0)
    ]),
  },
  list_audit_logs: {
    sql: `
      SELECT id, action, actor, created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT $1
    `,
    paramSchema: z.tuple([
      z.number().int().min(1).max(100)
    ]),
  }
};

const explainRequestSchema = z.object({
  queryId: z.string().refine((val) => val in ALLOWLISTED_QUERIES, {
    message: "queryId is not allowlisted",
  }),
  params: z.array(z.any()).default([]),
});

export function createAdminDbExplainRouter(opts: AdminDbExplainRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

  router.use(
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

  router.use(requireAdmin);

  router.post("/", async (req, res, next) => {
    try {
      const parsedBody = explainRequestSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            message: parsedBody.error.issues[0]?.message ?? "invalid request body",
            requestId: getRequestId(),
          },
        });
      }

      const { queryId, params } = parsedBody.data;
      const targetQuery = ALLOWLISTED_QUERIES[queryId];

      const parsedParams = targetQuery.paramSchema.safeParse(params);
      if (!parsedParams.success) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            message: "invalid query parameters: " + (parsedParams.error.issues[0]?.message ?? ""),
            requestId: getRequestId(),
          },
        });
      }

      // Execute EXPLAIN ANALYZE
      const sqlText = `EXPLAIN ANALYZE ${targetQuery.sql}`;
      const pool = getPool();
      const dbResult = await pool.query(sqlText, parsedParams.data);

      const explainPlan = dbResult.rows.map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return String(r["QUERY PLAN"] ?? Object.values(r)[0] ?? "");
      });

      logger.info(
        { reqId: getRequestId(), queryId, actor: req.adminAddress },
        "db_explain_executed"
      );

      return res.json({
        data: {
          queryId,
          explainPlan,
        },
      });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}

export const adminDbExplainRouter = createAdminDbExplainRouter();
