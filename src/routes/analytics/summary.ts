import { Router, type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { logger } from "../../config/logger";

interface AnalyticsSummaryRow {
  total_users: string | number;
  total_markets: string | number;
  active_markets: string | number;
  resolved_markets: string | number;
  total_predictions: string | number;
  total_volume: string | number | null;
}

export interface AnalyticsSummary {
  totalUsers: number;
  totalMarkets: number;
  activeMarkets: number;
  resolvedMarkets: number;
  totalPredictions: number;
  totalVolume: string;
}

function correlationIdFor(request: Request): string {
  const header = request.header("x-correlation-id");
  return header && header.trim().length > 0 ? header.trim() : crypto.randomUUID();
}

function integerValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "0";
  }

  return String(value);
}

function validateQuery(request: Request, response: Response): boolean {
  const keys = Object.keys(request.query);
  if (keys.length === 0) {
    return true;
  }

  response.status(400).json({
    error: {
      code: "validation_error",
      message: "The analytics summary endpoint does not accept query parameters",
      details: keys.map((key) => ({ path: [key], message: "Unknown query parameter" })),
    },
  });
  return false;
}

async function getSummary(request: Request, response: Response, next: NextFunction): Promise<void> {
  const correlationId = correlationIdFor(request);
  response.setHeader("x-correlation-id", correlationId);

  if (!validateQuery(request, response)) {
    return;
  }

  try {
    const result = await db.execute<AnalyticsSummaryRow>(sql`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM markets) AS total_markets,
        (SELECT COUNT(*) FROM markets WHERE status = 'active') AS active_markets,
        (SELECT COUNT(*) FROM markets WHERE status = 'resolved') AS resolved_markets,
        (SELECT COUNT(*) FROM predictions) AS total_predictions,
        (SELECT COALESCE(SUM(amount), 0) FROM predictions) AS total_volume
    `);

    const row = result.rows[0] ?? {
      total_users: 0,
      total_markets: 0,
      active_markets: 0,
      resolved_markets: 0,
      total_predictions: 0,
      total_volume: "0",
    };

    const data: AnalyticsSummary = {
      totalUsers: integerValue(row.total_users),
      totalMarkets: integerValue(row.total_markets),
      activeMarkets: integerValue(row.active_markets),
      resolvedMarkets: integerValue(row.resolved_markets),
      totalPredictions: integerValue(row.total_predictions),
      totalVolume: decimalValue(row.total_volume),
    };

    logger.info({ correlationId, event: "analytics.summary.read" }, "Analytics summary generated");
    response.json({ data });
  } catch (error) {
    logger.error({ correlationId, err: error, event: "analytics.summary.error" }, "Failed to generate analytics summary");
    next(error);
  }
}

export function createAnalyticsSummaryRouter(): Router {
  const router = Router();
  router.get("/", getSummary);
  return router;
}

export const analyticsSummaryRouter = createAnalyticsSummaryRouter();
