import { Router } from "express";
import { z } from "zod";
import { requireAuthForbidden } from "../../middleware/requireAuth";
import { AuthenticatedRequest } from "../../middleware/auth";
import {
  createQuotaRequest,
  getQuotaRequestsByUser,
  getPendingCountByUser,
  VALID_QUOTA_TYPES,
} from "../../services/quotaRequestService";
import { RouteErrorFactory } from "../../errors/RouteError";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";

export const quotaRequestsRouter = Router();

// Cap pending requests per user to prevent abuse of the self-service system.
const MAX_PENDING_REQUESTS = 5;

const createBodySchema = z.object({
  quotaType: z.enum(VALID_QUOTA_TYPES),
  requestedValue: z.number().int().min(1),
  reason: z.string().min(10).max(1000),
});

/**
 * POST /api/quota/requests
 *
 * Submit a new quota-increase request.  The caller must be authenticated.
 * At most MAX_PENDING_REQUESTS pending requests are allowed per user.
 *
 * Request body:
 *   - quotaType       — one of "prediction_limit", "daily_prediction_limit", "claim_limit"
 *   - requestedValue  — positive integer, the desired limit
 *   - reason          — 10–1000 character explanation
 *
 * Response 201: { data: QuotaRequestRow }
 * Errors:   400 too many pending, 422 validation, 401/403 auth
 */
quotaRequestsRouter.post(
  "/",
  requireAuthForbidden,
  async (req: AuthenticatedRequest, res, next) => {
    const reqId = getRequestId();

    try {
      // Validate and coerce the request body at the route boundary.
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw RouteErrorFactory.validation(
          "Invalid request body",
          parsed.error.flatten().fieldErrors as Record<string, string[]>,
        );
      }

      const userId = req.user!.id;

      // Reject if the user already has the maximum number of pending requests.
      const pendingCount = await getPendingCountByUser(userId);
      if (pendingCount >= MAX_PENDING_REQUESTS) {
        throw RouteErrorFactory.badRequest(
          `You already have ${pendingCount} pending quota request(s). Complete or cancel them before submitting a new one.`,
        );
      }

      const result = await createQuotaRequest({
        userId,
        ...parsed.data,
      });

      if (!result.ok) {
        throw result.error;
      }

      logger.info(
        { reqId, quotaRequestId: result.value.id, userId },
        "quota_request_submitted",
      );

      res.status(201).json({ data: result.value });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /api/quota/requests
 *
 * List all quota requests for the authenticated user, newest first.
 *
 * Response 200: { data: QuotaRequestRow[] }
 * Errors:   401/403 auth
 */
quotaRequestsRouter.get(
  "/",
  requireAuthForbidden,
  async (req: AuthenticatedRequest, res, next) => {
    const reqId = getRequestId();

    try {
      const userId = req.user!.id;

      const result = await getQuotaRequestsByUser(userId);

      if (!result.ok) {
        throw result.error;
      }

      logger.info(
        { reqId, userId, count: result.value.length },
        "quota_requests_listed",
      );

      res.json({ data: result.value });
    } catch (e) {
      next(e);
    }
  },
);
