/**
 * Admin Notification Broadcast Router.
 *
 * POST /api/admin/notifications/broadcast
 *   Broadcasts a notification to all registered platform users.
 *   Requires a valid admin JWT (role: "admin") in the Authorization header.
 *   Rate-limited to 60 requests per minute per admin token.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { logger } from "../../../config/logger";
import { RouteErrorFactory } from "../../../errors";
import { getRequestId } from "../../../lib/requestContext";
import { getCorrelationId } from "../../../middleware/correlation";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { broadcastNotification } from "../../../services/notificationService";

export interface AdminBroadcastRouterOptions {
  rateLimitPerMinute?: number;
}

const broadcastBodySchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "title must not be empty")
      .max(255, "title must be at most 255 characters"),
    body: z
      .string()
      .trim()
      .min(1, "body must not be empty")
      .max(2000, "body must be at most 2000 characters"),
    type: z
      .string()
      .trim()
      .min(1, "type must not be empty")
      .max(64, "type must be at most 64 characters")
      .optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict();

export function createAdminBroadcastRouter(
  opts: AdminBroadcastRouterOptions = {},
): Router {
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
      const parsed = broadcastBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw RouteErrorFactory.validation(
          parsed.error.issues[0]?.message ?? "invalid broadcast request body",
        );
      }

      const requestId = getRequestId();
      const correlationId = getCorrelationId() ?? res.locals.correlationId;
      const adminAddress = req.adminAddress;

      logger.info(
        {
          event: "admin_notification_broadcast_requested",
          requestId,
          correlationId,
          actor: adminAddress,
          title: parsed.data.title,
          type: parsed.data.type ?? "system_broadcast",
        },
        "admin_notification_broadcast_requested",
      );

      const result = await broadcastNotification(parsed.data);

      logger.info(
        {
          event: "admin_notification_broadcast_completed",
          requestId,
          correlationId,
          actor: adminAddress,
          recipientCount: result.recipientCount,
          notificationCount: result.notificationCount,
        },
        "admin_notification_broadcast_completed",
      );

      res.status(201).json({
        data: {
          recipientCount: result.recipientCount,
          notificationCount: result.notificationCount,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminBroadcastRouter = createAdminBroadcastRouter();
