import { Router } from "express";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { requireAdmin } from "../middleware/requireAdmin";
import { webhooksMetricsMiddleware } from "../metrics/webhooksMetrics";
import type { IWebhookDispatcher } from "../services/webhookDispatcher";
import type { DlqRow, WebhookStore } from "../services/webhookStore";
import { RouteErrorFactory } from "../errors";
import { dlqQuerySchema, dlqReplayParamsSchema } from "../validators/webhooks";

export interface AdminWebhookDeps {
  store: WebhookStore;
  dispatcher: IWebhookDispatcher;
}

interface ReplayResult {
  id: string;
  status: string;
  attempts: number;
}

function serializeDlqRow(row: DlqRow) {
  return {
    id: row.id,
    originalId: row.originalId,
    eventId: row.eventId,
    eventType: row.eventType,
    targetUrl: row.targetUrl,
    payloadBase64: row.payload.toString("base64"),
    signature: row.signature,
    headers: row.headers,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    failedAt: row.failedAt.toISOString(),
    replayedAt: row.replayedAt ? row.replayedAt.toISOString() : null,
    replayDeliveryId: row.replayDeliveryId,
  };
}

export function createAdminWebhooksRouter(deps: AdminWebhookDeps): Router {
  const router = Router();
  router.use(webhooksMetricsMiddleware);
  router.use(requireAdmin);

  router.get("/dlq", async (req, res, next) => {
    const requestId = getRequestId();

    try {
      const parseResult = dlqQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        const issue = parseResult.error.issues[0];
        logger.warn(
          {
            event: "dlq_list_validation_failed",
            requestId,
            adminAddress: req.adminAddress,
            issues: parseResult.error.issues,
          },
          "DLQ list: invalid query parameters",
        );
        res.status(400).json({
          error: {
            code: "validation_error",
            message: issue?.message ?? "invalid query parameters",
            requestId,
          },
        });
        return;
      }

      const { cursor, limit } = parseResult.data;
      const page = await deps.store.listDlq(cursor, limit);
      return res.json({
        data: page.data.map(serializeDlqRow),
        nextCursor: page.nextCursor,
      });
    } catch (e) {
      logger.error(
        {
          event: "dlq_list_error",
          requestId,
          adminAddress: req.adminAddress,
          error: e instanceof Error ? e.message : String(e),
        },
        "DLQ list encountered an unexpected error",
      );
      return next(e);
    }
  });

  router.post("/dlq/:id/replay", async (req, res, next) => {
    const requestId = getRequestId();

    try {
      const parseResult = dlqReplayParamsSchema.safeParse(req.params);
      if (!parseResult.success) {
        const issue = parseResult.error.issues[0];
        logger.warn(
          {
            event: "dlq_replay_validation_failed",
            requestId,
            adminAddress: req.adminAddress,
            issues: parseResult.error.issues,
          },
          "DLQ replay: invalid parameters",
        );
        throw RouteErrorFactory.badRequest(
          issue?.message ?? "invalid parameters",
        );
      }

      const { id } = parseResult.data;
      const row = await deps.store.getDlqRow(id);
      if (!row) {
        throw RouteErrorFactory.notFound("DLQ row not found");
      }
      if (row.replayedAt) {
        return res.status(409).json({
          error: { type: "already_replayed" },
          replayDeliveryId: row.replayDeliveryId,
        });
      }

      const fresh = (await deps.dispatcher.replayFromDlq(row)) as ReplayResult | null;
      if (!fresh) {
        return res.status(409).json({ error: { type: "already_replayed" } });
      }

      return res.status(202).json({
        data: {
          deliveryId: fresh.id,
          status: fresh.status,
          attempts: fresh.attempts,
        },
      });
    } catch (e) {
      logger.error(
        {
          event: "dlq_replay_error",
          requestId,
          adminAddress: req.adminAddress,
          error: e instanceof Error ? e.message : String(e),
        },
        "DLQ replay encountered an unexpected error",
      );
      return next(e);
    }
  });

  return router;
}
