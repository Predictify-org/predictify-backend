import { z } from "zod";

/**
 * Zod validation schemas for /api/alerts.
 *
 * Unknown query/body parameters are rejected to keep the route boundary
 * explicit and to avoid silently ignoring malformed input.
 *
 * Failures throw ZodError, which is caught centrally by errorHandler.ts
 * and converted into a standardized 400 envelope:
 *   { error: { code: "validation_error", message, details, correlationId } }
 */

/** Allowed alert severity levels, matching the /api/alerts response shape. */
const alertSeverityEnum = z.enum(["info", "warning", "critical"], {
  message: "severity must be one of: info, warning, critical",
});

/**
 * Schema for GET /api/alerts query parameters.
 *
 * - unreadOnly: filter to only unread alerts
 * - severity: filter to a single severity level
 * - limit: max number of alerts to return (1-100, default 20)
 * - cursor: opaque pagination cursor (accepted now, unused until the
 *   database-backed alert store lands)
 */
export const listAlertsQuerySchema = z
  .object({
    unreadOnly: z
      .enum(["true", "false"], {
        message: "unreadOnly must be 'true' or 'false'",
      })
      .optional()
      .transform((v) => v === "true"),
    severity: alertSeverityEnum.optional(),
    cursor: z
      .string({ invalid_type_error: "cursor must be a string" })
      .trim()
      .min(1, "cursor must be a non-empty string")
      .optional(),
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(20),
  })
  .strict();

export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

/**
 * Schema for PATCH /api/alerts/read body.
 *
 * - alertIds: optional array of alert UUIDs to mark as read. If omitted
 *   or empty, all of the user's alerts are marked as read.
 */
export const markAlertsReadBodySchema = z
  .object({
    alertIds: z
      .array(z.string().uuid("each alertId must be a valid UUID"))
      .max(500, "alertIds must contain at most 500 entries")
      .optional(),
  })
  .strict();

export type MarkAlertsReadBody = z.infer<typeof markAlertsReadBodySchema>;
