/**
 * @module validators/subscriptions
 *
 * Zod schemas for the /api/subscriptions endpoints.
 *
 * All schemas use `.strict()` on object types so that unrecognised keys are
 * rejected at the route boundary rather than silently ignored. This keeps the
 * contract explicit and prevents parameter-smuggling attacks.
 *
 * Exported schemas
 * ────────────────
 *   createSubscriptionBodySchema  — POST /api/subscriptions body
 *   patchSubscriptionBodySchema   — PATCH /api/subscriptions/:id body
 *   subscriptionIdParamSchema     — :id path parameter (UUID)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of event-type strings accepted in one subscription. */
const MAX_EVENTS = 50;

/** Maximum byte-length of an event-type string. */
const MAX_EVENT_LENGTH = 128;

/** Maximum byte-length of a webhook URL. */
const MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * A single webhook event-type token.
 *
 * Format: `<resource>.<action>` — e.g. "market.created", "prediction.settled".
 * Characters: alphanumeric, underscore, hyphen, and a single dot separator.
 */
export const eventTypeSchema = z
  .string({
    invalid_type_error: "Each event type must be a string",
  })
  .trim()
  .min(1, "Event type must not be empty")
  .max(MAX_EVENT_LENGTH, `Event type must be at most ${MAX_EVENT_LENGTH} characters`)
  .regex(
    /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/,
    "Event type must be in the format '<resource>.<action>' (e.g. 'market.created')",
  );

/**
 * Array of webhook event-type tokens.
 *
 * At least one event must be provided; duplicates are coerced away.
 */
export const eventsArraySchema = z
  .array(eventTypeSchema, {
    invalid_type_error: "events must be an array of strings",
    required_error: "events is required",
  })
  .min(1, "At least one event type is required")
  .max(MAX_EVENTS, `At most ${MAX_EVENTS} event types are allowed`)
  .transform((evs) => [...new Set(evs)]);

/**
 * A valid HTTPS webhook delivery URL.
 *
 * We require HTTPS in production-like contexts to prevent accidental
 * plaintext delivery of signed payloads.
 */
export const webhookUrlSchema = z
  .string({
    required_error: "url is required",
    invalid_type_error: "url must be a string",
  })
  .trim()
  .min(1, "url must not be empty")
  .max(MAX_URL_LENGTH, `url must be at most ${MAX_URL_LENGTH} characters`)
  .url("url must be a valid URL")
  .refine(
    (val) => {
      try {
        const parsed = new URL(val);
        return parsed.protocol === "https:" || parsed.hostname === "localhost";
      } catch {
        return false;
      }
    },
    { message: "url must use HTTPS (HTTP allowed only for localhost)" },
  );

// ---------------------------------------------------------------------------
// POST /api/subscriptions — create body
// ---------------------------------------------------------------------------

/**
 * Request body schema for creating a new webhook subscription.
 *
 * Required fields:
 *   - url     : HTTPS webhook endpoint URL
 *   - events  : Non-empty array of "<resource>.<action>" event tokens
 *
 * Unknown keys are rejected via `.strict()`.
 */
export const createSubscriptionBodySchema = z
  .object({
    url: webhookUrlSchema,
    events: eventsArraySchema,
  })
  .strict();

export type CreateSubscriptionBody = z.infer<typeof createSubscriptionBodySchema>;

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/:id — update body
// ---------------------------------------------------------------------------

/**
 * Request body schema for partially updating a webhook subscription.
 *
 * All fields are optional but at least one must be provided.
 * Unknown keys are rejected via `.strict()`.
 */
export const patchSubscriptionBodySchema = z
  .object({
    url: webhookUrlSchema.optional(),
    events: eventsArraySchema.optional(),
    active: z
      .boolean({
        invalid_type_error: "active must be a boolean",
      })
      .optional(),
  })
  .strict()
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: "At least one field (url, events, active) must be provided for an update" },
  );

export type PatchSubscriptionBody = z.infer<typeof patchSubscriptionBodySchema>;

// ---------------------------------------------------------------------------
// :id path parameter
// ---------------------------------------------------------------------------

/**
 * Path parameter schema for endpoints that require a subscription UUID.
 *
 *   :id — a UUID v4 string identifying the target subscription
 */
export const subscriptionIdParamSchema = z.object({
  id: z
    .string({
      required_error: "Subscription ID is required",
      invalid_type_error: "Subscription ID must be a string",
    })
    .uuid("Subscription ID must be a valid UUID"),
});

export type SubscriptionIdParam = z.infer<typeof subscriptionIdParamSchema>;
