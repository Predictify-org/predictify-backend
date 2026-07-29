import { randomUUID } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { pool } from "../../db/client";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";
import { accessLog } from "../../middleware/accessLog";

export interface UsersHealthDependencyStatus {
  status: "ok" | "down";
  latencyMs: number;
  error?: string;
}

function resolveCorrelationId(req: Request, res: Response): string {
  const resCorrelationId = res.locals.correlationId as string | undefined;
  const headerValue = [req.headers["x-correlation-id"], req.headers["x-request-id"]]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

  return (resCorrelationId ?? headerValue?.trim() ?? getRequestId() ?? randomUUID()).trim();
}

async function probeDatabase(): Promise<UsersHealthDependencyStatus> {
  const startedAt = Date.now();

  try {
    await pool.query("SELECT 1");
    return {
      status: "ok",
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Database health probe failed",
    };
  }
}

export function createUsersHealthRouter(): Router {
  const router = Router();

  router.use(accessLog);

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = resolveCorrelationId(req, res);
    const startedAt = Date.now();

    try {
      const database = await probeDatabase();
      const status = database.status === "ok" ? "ok" : "down";
      const httpStatus = status === "ok" ? 200 : 503;

      logger.info(
        {
          correlationId,
          status,
          database,
          elapsedMs: Date.now() - startedAt,
        },
        "users_health_checked",
      );

      return res.status(httpStatus).json({
        status,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies: {
          database,
        },
      });
    } catch (error) {
      logger.error({ correlationId, error }, "users_health_probe_failed");
      return next(error);
    }
  });

  return router;
}

export const usersHealthRouter = createUsersHealthRouter();
