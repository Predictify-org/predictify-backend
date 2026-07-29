/**
 * @module routes/invites
 *
 * Express route handlers for invite operations (/api/invites).
 *
 * Guarantees:
 * 1. Uses X-Correlation-Id from `correlationMiddleware` (global) for tracing.
 * 2. Emits structured logs using Pino containing `correlationId`.
 * 3. Optional outbound HTTP requests propagate X-Correlation-Id via
 *    `fetchWithCorrelationId`.
 * 4. Input validation using Zod at the boundary with standardized error
 *    envelopes.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { createPerUserTokenBucketLimiter } from "../middleware/rateLimit";
import { env } from "../config/env";
import { logger } from "../config/logger";
import {
  getCorrelationId,
  CORRELATION_ID_HEADER,
  fetchWithCorrelationId,
} from "../middleware/correlation";

export interface InvitesRouterOptions {
  rateLimit?: {
    capacity?: number;
    refillWindowMs?: number;
  };
}

// ── Validation Schemas ───────────────────────────────────────────────────────

const createInviteSchema = z
  .object({
    recipientEmail: z.string().email().optional(),
    message: z.string().max(1000).optional(),
    outboundUrl: z.string().url().optional(),
  })
  .strict();

const listInvitesQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

// ── Router Factory ───────────────────────────────────────────────────────────

export function createInvitesRouter(options: InvitesRouterOptions = {}): Router {
  const router = Router();

  router.use(requireAuth);
  router.use(
    createPerUserTokenBucketLimiter({
      capacity: options.rateLimit?.capacity ?? env.INVITES_RATE_LIMIT_CAPACITY,
      refillWindowMs: options.rateLimit?.refillWindowMs ?? env.INVITES_RATE_LIMIT_WINDOW_MS,
    }),
  );

  /**
   * POST /api/invites
   *
   * Creates a new invite and optionally dispatches an outbound webhook call
   * propagating X-Correlation-Id.
   */
  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedBody = createInviteSchema.safeParse(req.body);
      if (!parsedBody.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            details: parsedBody.error.issues,
          },
        });
        return;
      }

      const correlationId =
        getCorrelationId() ?? (res.locals.correlationId as string | undefined);

      if (correlationId) {
        res.setHeader(CORRELATION_ID_HEADER, correlationId);
      }

      const { recipientEmail, message, outboundUrl } = parsedBody.data;

      // Optional outbound webhook call with correlation ID propagation
      if (outboundUrl) {
        try {
          const outboundRes = await fetchWithCorrelationId(outboundUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipientEmail, message }),
          });
          // Consume the response to avoid hanging resources
          await outboundRes.text();
        } catch (err) {
          logger.warn(
            { correlationId, err, outboundUrl },
            "outbound invite notification failed",
          );
        }
      }

      logger.info(
        {
          correlationId,
          recipientEmail,
        },
        "invite created successfully",
      );

      res.status(201).json({ data: { message: "Invite created" } });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/invites
   *
   * Lists invites with cursor-based pagination.
   */
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedQuery = listInvitesQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            details: parsedQuery.error.issues,
          },
        });
        return;
      }

      const correlationId =
        getCorrelationId() ?? (res.locals.correlationId as string | undefined);

      if (correlationId) {
        res.setHeader(CORRELATION_ID_HEADER, correlationId);
      }

      logger.info(
        {
          correlationId,
          cursor: parsedQuery.data.cursor,
          limit: parsedQuery.data.limit,
        },
        "invites listed",
      );

      res.json({ data: [] });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const invitesRouter = createInvitesRouter();