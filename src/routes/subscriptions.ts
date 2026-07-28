/**
 * src/routes/subscriptions.ts
 *
 * Admin-facing webhook subscription management.
 * Mounted at `/api/subscriptions`.
 *
 * All endpoints require admin authentication (`requireAdmin`).
 * Input validation is enforced at the route boundary using the Zod schemas
 * exported from `src/validators/subscriptions.ts`.
 * Structured logging with correlation / request IDs is emitted on every
 * operation. All errors follow the project's standard error envelope.
 *
 * Endpoints
 * ─────────
 *   GET    /          — list all webhook subscriptions
 *   POST   /          — create a new webhook subscription
 *   GET    /:id       — fetch a single subscription by UUID
 *   PATCH  /:id       — partially update a subscription
 *   DELETE /:id       — delete a subscription
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { webhookSubscriptions } from "../db/schema";
import { conditionalGet } from "../middleware/etag";
import { requireAdmin } from "../middleware/requireAdmin";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { RouteErrorFactory } from "../errors";
import {
  createSubscriptionBodySchema,
  patchSubscriptionBodySchema,
  subscriptionIdParamSchema,
} from "../validators/subscriptions";

export const subscriptionsRouter = Router();

// All subscription management endpoints are admin-only.
subscriptionsRouter.use(requireAdmin);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the internal `secret` from a subscription row before returning it to
 * the client. The secret is only exposed once, at creation time.
 */
function serializeSub(
  row: typeof webhookSubscriptions.$inferSelect,
): Omit<typeof webhookSubscriptions.$inferSelect, "secret"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret: _secret, ...pub } = row;
  return pub;
}

// ---------------------------------------------------------------------------
// GET / — list all webhook subscriptions
// ---------------------------------------------------------------------------

subscriptionsRouter.get("/", async (req, res, next) => {
  const reqId = getRequestId();

  try {
    const subscriptions = await db.select().from(webhookSubscriptions);

    logger.debug({ reqId, count: subscriptions.length }, "subscriptions_listed");

    // ETag / conditional-GET support — returns 304 when content unchanged.
    if (conditionalGet(subscriptions, req, res)) {
      return;
    }

    res.json({ data: subscriptions.map(serializeSub) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — create a new webhook subscription
// ---------------------------------------------------------------------------

subscriptionsRouter.post("/", async (req, res, next) => {
  const reqId = getRequestId();

  try {
    // --- Input validation ---
    const parsed = createSubscriptionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { reqId, issues: parsed.error.issues },
        "subscriptions_create_validation_failed",
      );
      // Re-throw as a ZodError so errorHandler formats it consistently.
      throw parsed.error;
    }

    const { url, events } = parsed.data;

    // Generate an HMAC signing secret for the subscription.
    const secret = uuidv4();

    const [row] = await db
      .insert(webhookSubscriptions)
      .values({ url, events, secret })
      .returning();

    logger.info({ reqId, subscriptionId: row!.id }, "subscription_created");

    // Return the secret only once, at creation time.
    res.status(201).json({ data: { ...serializeSub(row!), secret } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — fetch a single subscription
// ---------------------------------------------------------------------------

subscriptionsRouter.get("/:id", async (req, res, next) => {
  const reqId = getRequestId();

  try {
    // --- Path parameter validation ---
    const paramParsed = subscriptionIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      throw RouteErrorFactory.badRequest(
        paramParsed.error.issues[0]?.message ?? "Invalid subscription ID",
      );
    }

    const { id } = paramParsed.data;

    const [row] = await db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id));

    if (!row) {
      logger.debug({ reqId, subscriptionId: id }, "subscription_not_found");
      throw RouteErrorFactory.notFound("Subscription not found");
    }

    logger.debug({ reqId, subscriptionId: id }, "subscription_fetched");

    res.json({ data: serializeSub(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id — partially update a subscription
// ---------------------------------------------------------------------------

subscriptionsRouter.patch("/:id", async (req, res, next) => {
  const reqId = getRequestId();

  try {
    // --- Path parameter validation ---
    const paramParsed = subscriptionIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      throw RouteErrorFactory.badRequest(
        paramParsed.error.issues[0]?.message ?? "Invalid subscription ID",
      );
    }

    const { id } = paramParsed.data;

    // --- Body validation ---
    const bodyParsed = patchSubscriptionBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      logger.warn(
        { reqId, subscriptionId: id, issues: bodyParsed.error.issues },
        "subscriptions_patch_validation_failed",
      );
      throw bodyParsed.error;
    }

    // Verify the subscription exists before attempting an update.
    const [existing] = await db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id));

    if (!existing) {
      logger.debug({ reqId, subscriptionId: id }, "subscription_not_found");
      throw RouteErrorFactory.notFound("Subscription not found");
    }

    const [updated] = await db
      .update(webhookSubscriptions)
      .set({ ...bodyParsed.data, updatedAt: new Date() })
      .where(eq(webhookSubscriptions.id, id))
      .returning();

    logger.info({ reqId, subscriptionId: updated!.id }, "subscription_updated");

    res.json({ data: serializeSub(updated!) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete a subscription
// ---------------------------------------------------------------------------

subscriptionsRouter.delete("/:id", async (req, res, next) => {
  const reqId = getRequestId();

  try {
    // --- Path parameter validation ---
    const paramParsed = subscriptionIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      throw RouteErrorFactory.badRequest(
        paramParsed.error.issues[0]?.message ?? "Invalid subscription ID",
      );
    }

    const { id } = paramParsed.data;

    const result = await db
      .delete(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id));

    if (result.rowCount === 0) {
      logger.debug({ reqId, subscriptionId: id }, "subscription_not_found");
      throw RouteErrorFactory.notFound("Subscription not found");
    }

    logger.info({ reqId, subscriptionId: id }, "subscription_deleted");

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
