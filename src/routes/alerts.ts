/**
 * /api/alerts — user-facing system alerts.
 *
 * Returns a list of active alerts for the authenticated user. Alerts can
 * include market resolution notifications, system announcements, and
 * other important events that require user attention.
 *
 * Response shape:
 * ```json
 * {
 *   "alerts": [
 *     {
 *       "id": "uuid",
 *       "type": "market_resolved" | "system" | "claim_available",
 *       "severity": "info" | "warning" | "critical",
 *       "title": "Market resolved",
 *       "message": "Will BTC reach $100K by June? has been resolved.",
 *       "link": "/markets/abc-123",
 *       "read": false,
 *       "createdAt": "2026-07-28T12:00:00.000Z"
 *     }
 *   ],
 *   "unreadCount": 1
 * }
 * ```
 *
 * Request validation
 * ───────────────────
 * GET  /       — query params validated against listAlertsQuerySchema
 *                (unreadOnly, severity, limit, cursor)
 * PATCH /read  — body validated against markAlertsReadBodySchema
 *                (optional alertIds array)
 *
 * Invalid input throws ZodError, which errorHandler.ts converts into a
 * standardized 400 response: { error: { code: "validation_error", ... } }
 *
 * Security
 * ────────
 * Requires authentication. Only returns alerts belonging to the requesting
 * user.
 */
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import type { AuthenticatedRequest } from "../middleware/auth";
import { listAlertsQuerySchema, markAlertsReadBodySchema } from "../validators/alerts";

export const alertsRouter = Router();

// All alert routes require authentication
alertsRouter.use(requireAuth);

/**
 * GET /
 *
 * Returns all active alerts for the authenticated user, ordered by
 * creation date descending. Supports filtering by read status and
 * severity, plus pagination via limit/cursor.
 */
alertsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  const reqId = getRequestId();
  const userId = (req as AuthenticatedRequest).user?.id;

  try {
    // Validate at the boundary. Throws ZodError -> handled centrally
    // by errorHandler.ts as a structured 400 response.
    const query = listAlertsQuerySchema.parse(req.query);

    logger.debug({ reqId, userId, query }, "alerts_list_request");

    // TODO: Replace with database-backed alert store when available.
    // For now, return an empty list as the baseline response shape.
    // `query` (unreadOnly, severity, limit, cursor) is validated and
    // ready to be passed through once the store exists.
    const alerts: Array<{
      id: string;
      type: string;
      severity: string;
      title: string;
      message: string;
      link: string | null;
      read: boolean;
      createdAt: string;
    }> = [];
    const unreadCount = 0;

    logger.info({ reqId, userId, count: alerts.length, unreadCount }, "alerts_list_served");
    res.json({ alerts, unreadCount });
  } catch (err) {
    logger.error({ reqId, userId, err }, "alerts_list_failed");
    next(err);
  }
});

/**
 * PATCH /read
 *
 * Marks alerts as read for the authenticated user. If `alertIds` is
 * provided in the body, only those alerts are marked read; otherwise
 * all of the user's alerts are marked read.
 */
alertsRouter.patch("/read", async (req: Request, res: Response, next: NextFunction) => {
  const reqId = getRequestId();
  const userId = (req as AuthenticatedRequest).user?.id;

  try {
    const body = markAlertsReadBodySchema.parse(req.body);

    logger.debug({ reqId, userId, alertIds: body.alertIds }, "alerts_mark_read_request");

    // TODO: Implement database-backed mark-read when alert store is available.
    // `body.alertIds` (if present) scopes the update to specific alerts.
    logger.info({ reqId, userId }, "alerts_mark_read_complete");
    res.json({ success: true });
  } catch (err) {
    logger.error({ reqId, userId, err }, "alerts_mark_read_failed");
    next(err);
  }
});
