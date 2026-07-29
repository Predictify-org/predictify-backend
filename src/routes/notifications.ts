import {
  Router,
  type Request,
} from "express";
import { z } from "zod";
import { logger } from "../config/logger";
import { requireAuth } from "../middleware/requireAuth";
import {
  getNotificationPreferences,
  notificationCategories,
  notificationChannels,
  patchNotificationPreferences,
} from "../services/notificationPrefs";
import { markNotificationsAsRead } from "../services/notificationService";
import { idempotency } from "../middleware/idempotency";
import { RouteErrorFactory } from "../errors";
import { notificationsCors } from "../middleware/cors";
import { notificationsMetricsMiddleware } from "../metrics/notificationsMetrics";

const notificationCategorySchema = z.enum(notificationCategories);
const notificationChannelSchema = z.enum(notificationChannels);

const patchPreferencesBodySchema = z
  .object({
    preferences: z
      .array(
        z
          .object({
            category: notificationCategorySchema,
            channel: notificationChannelSchema,
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const uuidSchema = z.string().uuid();
const markReadBodySchema = z
  .object({
    notificationIds: z.array(uuidSchema).optional(),
    markAllAsRead: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => (data.notificationIds?.length ?? 0) > 0 || data.markAllAsRead === true,
    {
      message: "Either notificationIds (non-empty array) or markAllAsRead=true is required",
      path: ["notificationIds"],
    },
  );

export const notificationsRouter = Router();

// Enforce CORS allowlist early so unapproved origins are rejected
// before any processing (preflight responses cached via Access-Control-Max-Age).
notificationsRouter.use(notificationsCors());
notificationsRouter.use(requireAuth);
notificationsRouter.use(notificationsMetricsMiddleware);

notificationsRouter.get(
  "/preferences",
  async (req, res, next) => {
    try {
      const userId = (req as Request & { user: { id: string } }).user.id;
      const preferences = await getNotificationPreferences(userId);

      logger.info(
        {
          reqId: (req as Request & { id?: string }).id,
          userId,
          preferenceCount: preferences.length,
        },
        "notification_preferences_loaded",
      );

      return res.status(200).json({
        data: {
          preferences,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

notificationsRouter.patch(
  "/preferences",
  idempotency,
  async (req, res, next) => {
    const parsed = patchPreferencesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        {
          reqId: (req as Request & { id?: string }).id,
          issues: parsed.error.issues,
        },
        "notification_preferences_validation_failed",
      );
      return next(RouteErrorFactory.validation("Invalid request body"));
    }

    try {
      const userId = (req as Request & { user: { id: string } }).user.id;
      const preferences = await patchNotificationPreferences(
        userId,
        parsed.data.preferences,
      );

      logger.info(
        {
          reqId: (req as Request & { id?: string }).id,
          userId,
          updatedCount: parsed.data.preferences.length,
        },
        "notification_preferences_updated",
      );

      return res.status(200).json({
        data: {
          preferences,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

notificationsRouter.post(
  "/mark-read",
  idempotency,
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = markReadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        {
          reqId: (req as Request & { id?: string }).id,
          issues: parsed.error.issues,
        },
        "notifications_mark_read_validation_failed",
      );

      return res.status(400).json({
        error: {
          code: "validation_error",
          details: parsed.error.issues,
        },
      });
    }

    try {
      const userId = (req as Request & { user: { id: string } }).user.id;
      const { notificationIds, markAllAsRead } = parsed.data;

      const result = await markNotificationsAsRead({
        userId,
        notificationIds,
        markAllAsRead,
      });

      logger.info(
        {
          reqId: (req as Request & { id?: string }).id,
          userId,
          updatedCount: result.updatedCount,
          markAllAsRead: markAllAsRead ?? false,
        },
        "notifications_marked_read",
      );

      return res.status(200).json({
        data: {
          updatedCount: result.updatedCount,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);