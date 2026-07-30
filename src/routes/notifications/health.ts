import { randomUUID } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { pool } from "../../db/client";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";

export interface NotificationsHealthDependencyStatus {
  status: "ok" | "down";
  latencyMs: number;
  error?: string;
}

export interface NotificationsHealthRouterDeps {
  probeDatabase?: () => Promise<NotificationsHealthDependencyStatus>;
}

function resolveCorrelationId(req: Request, res: Response): string {
  const resCorrelationId = res.locals.correlationId as string | undefined;
  const headerValue = [req.headers["x-correlation-id"], req.headers["x-request-id"]]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

  return (resCorrelationId ?? headerValue?.trim() ?? getRequestId() ?? randomUUID()).trim();
}

async function defaultProbeDatabase(): Promise<NotificationsHealthDependencyStatus> {
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

/**
 * Creates the /api/notifications/health router with injected dependencies.
 *
 * @param deps - Override probe functions for testing. Defaults to production
 *               implementations that hit real Postgres.
 */
export function createNotificationsHealthRouter(
  deps: NotificationsHealthRouterDeps = {},
): Router {
  const probeDatabase = deps.probeDatabase ?? defaultProbeDatabase;
  const router = Router();

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
        "notifications_health_checked",
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
      logger.error({ correlationId, error }, "notifications_health_probe_failed");
      return next(error);
    }
  });

  return router;
}

/** Production router instance wired into src/index.ts. */
export const notificationsHealthRouter = createNotificationsHealthRouter();
