/**
 * User-facing webhook subscription management.
 *
 * Mounted at `/api/webhooks`. All endpoints require authentication and
 * are subject to a **per-user** rate limit configured via:
 *
 *   - WEBHOOKS_RATE_LIMIT_WINDOW_MS  (default 15 min)
 *   - WEBHOOKS_RATE_LIMIT_MAX        (default 100 requests)
 *
 * Rate-limit keying is based on the authenticated stellar address populated by
 * `requireAuth`, so quota is tracked independently per user, not per IP.
 *
 * All routes are wrapped by `accessLog` which:
 *   - Resolves a correlation ID via the priority chain (header → req.id → UUID)
 *   - Echoes it back in the `X-Correlation-Id` response header
 *   - Emits a structured `webhooks_access_log` entry on every response finish.
 *
 * Endpoints:
 *   GET    /          — list webhook subscriptions
 *   POST   /          — create a new webhook subscription
 *   GET    /:id       — fetch a single subscription (by UUID)
 *   PATCH  /:id       — update a subscription (URL, events, active flag)
 *   DELETE /:id       — deactivate / remove a subscription
 *
 * All mutations are protected by the idempotency layer that runs before
 * any `/api/*` POST / PATCH handler in `src/index.ts`.
 */

import { Router } from "express";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { accessLog } from "../middleware/accessLog";
import { webhookCors } from "../middleware/cors";
import { requireAdmin } from "../middleware/requireAdmin";
import { webhooksRateLimiter } from "../middleware/rateLimit";
import { correlationMiddleware, getCorrelationId } from "../middleware/correlation";

// ---------------------------------------------------------------------------
// Zod schemas — boundary validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const webhooksRouter = Router();

// Structured access log — resolves correlation ID, echoes it back, and
// emits a webhooks_access_log entry on every response finish.
// Mounted first so the correlation ID is available to all downstream handlers.
webhooksRouter.use(accessLog);

// Enforce CORS allowlist before admin auth so unapproved origins are
// rejected early without leaking auth challenge details.
webhooksRouter.use(webhookCors());
webhooksRouter.use(correlationMiddleware);
webhooksRouter.use(webhooksRateLimiter);
webhooksRouter.use(requireAdmin);

webhooksRouter.get("/", async (req, res, next) => {
  const reqId = getRequestId();
  const correlationId = getCorrelationId();
  const userId = req.user!.id;

  try {
    const rows = await db
      .select()
      .from(webhookSubscriptions)
      .orderBy(webhookSubscriptions.createdAt);

    logger.debug(
      { reqId, correlationId, userId, count: rows.length },
      "webhooks_listed",
    );

    return res.json({ data: rows.map(serializeSub) });
  } catch (err) {
    return next(err);
  }
});

// ── Create ────────────────────────────────────────────────────────────────

webhooksRouter.post("/", async (req, res, next) => {
  const reqId = getRequestId();
  const correlationId = getCorrelationId();
  const userId = req.user!.id;

  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      logger.warn(
        { reqId, correlationId, userId, issues: parsed.error.issues },
        "webhooks_create_validation_failed",
      );
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: issue.message,
          requestId: reqId,
          correlationId: correlationId,
        },
      });
    }

    const { url, events } = parsed.data;
    const secret = uuidv4();

    const [row] = await db
      .insert(webhookSubscriptions)
      .values({ url, events, secret })
      .returning();

    logger.info(
      { reqId, correlationId, userId, subscriptionId: row.id },
      "webhooks_subscription_created",
    );

    return res.status(201).json({
      data: { ...serializeSub(row), secret },
    });
  } catch (err) {
    return next(err);
  }
});

// ── Get by id ─────────────────────────────────────────────────────────────

webhooksRouter.get("/:id", async (req, res, next) => {
  const reqId = getRequestId();
  const correlationId = getCorrelationId();
  const userId = req.user!.id;

  try {
    const idParse = idParamSchema.safeParse(req.params.id);
    if (!idParse.success) {
      throw RouteErrorFactory.validation(idParse.error.issues[0]?.message ?? "invalid id");
    }

    const [row] = await db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, idParse.data));

    if (!row) {
      logger.debug(
        { reqId, correlationId, userId, subscriptionId: idParse.data },
        "webhooks_subscription_not_found",
      );
      throw RouteErrorFactory.notFound("Subscription not found");
    }

    return res.json({ data: serializeSub(row) });
  } catch (err) {
    return next(err);
  }
});

// ── Update ────────────────────────────────────────────────────────────────

webhooksRouter.patch("/:id", async (req, res, next) => {
  const reqId = getRequestId();
  const correlationId = getCorrelationId();
  const userId = req.user!.id;

  try {
    const idParse = idParamSchema.safeParse(req.params.id);
    if (!idParse.success) {
      throw RouteErrorFactory.validation(idParse.error.issues[0]?.message ?? "invalid id");
    }

    const bodyParse = updateSchema.safeParse(req.body);
    if (!bodyParse.success) {
      const issue = bodyParse.error.issues[0]!;
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: issue.message,
          requestId: reqId,
          correlationId: correlationId,
        },
      });
    }

    const [existing] = await db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, idParse.data));

    if (!existing) {
      throw RouteErrorFactory.notFound("Subscription not found");
    }

    const [updated] = await db
      .update(webhookSubscriptions)
      .set({ ...bodyParse.data, updatedAt: new Date() })
      .where(eq(webhookSubscriptions.id, idParse.data))
      .returning();

    logger.info(
      { reqId, correlationId, userId, subscriptionId: updated.id },
      "webhooks_subscription_updated",
    );

    return res.json({ data: serializeSub(updated) });
  } catch (err) {
    return next(err);
  }
});

// ── Delete / deactivate ───────────────────────────────────────────────────

webhooksRouter.delete("/:id", async (req, res, next) => {
  const reqId = getRequestId();
  const correlationId = getCorrelationId();
  const userId = req.user!.id;

  try {
    const idParse = idParamSchema.safeParse(req.params.id);
    if (!idParse.success) {
      throw RouteErrorFactory.validation(idParse.error.issues[0]?.message ?? "invalid id");
    }

    const result = await db
      .delete(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, idParse.data));

    if (result.rowCount === 0) {
      throw RouteErrorFactory.notFound("Subscription not found");
    }

    logger.info(
      { reqId, correlationId, userId, subscriptionId: idParse.data },
      "webhooks_subscription_deleted",
    );

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});
