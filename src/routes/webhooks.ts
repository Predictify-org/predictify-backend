import { Router } from "express";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { requireAdmin } from "../middleware/requireAdmin";
import { webhooksMetricsMiddleware } from "../metrics/webhooksMetrics";
import type { WebhookStore, WebhookDelivery } from "../services/webhookStore";
import { listWebhooksQuerySchema } from "../validators/webhooks";

export interface WebhooksRouterDeps {
  store: WebhookStore;
}

function serializeDelivery(row: WebhookDelivery) {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    targetUrl: row.targetUrl,
    payloadBase64: row.payload.toString("base64"),
    signature: row.signature,
    headers: row.headers,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createWebhooksRouter(deps: WebhooksRouterDeps): Router {
  const router = Router();

  router.use(webhooksMetricsMiddleware);
  router.use(requireAdmin);

  router.get("/", async (req, res, next) => {
    const requestId = getRequestId();

    try {
      const parseResult = listWebhooksQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        const issue = parseResult.error.issues[0];
        logger.warn(
          {
            event: "webhooks_list_validation_failed",
            requestId,
            adminAddress: req.adminAddress,
            issues: parseResult.error.issues,
          },
          "Webhook list: invalid query parameters",
        );
        return res.status(400).json({
          error: {
            code: "validation_error",
            message: issue?.message ?? "invalid query parameters",
            requestId,
          },
        });
      }

      const { cursor, limit } = parseResult.data;
      const page = await deps.store.listDeliveries(cursor, limit);
      return res.json({
        data: page.data.map(serializeDelivery),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export const webhooksRouter = Router();
