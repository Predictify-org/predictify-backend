import { z } from "zod";

/**
 * Schema for GET /api/webhooks query parameters.
 *
 * Keyset pagination with cursor + limit. Unknown parameters are
 * rejected to keep the route boundary explicit.
 */
export const listWebhooksQuerySchema = z
  .object({
    cursor: z
      .string({ invalid_type_error: "cursor must be a string" })
      .min(1, "cursor must not be empty when provided")
      .optional(),
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .optional(),
  })
  .strict();

export type ListWebhooksQuery = z.infer<typeof listWebhooksQuerySchema>;

/**
 * Schema for GET /api/admin/webhooks/dlq query parameters.
 */
export const dlqQuerySchema = z
  .object({
    cursor: z
      .string({ invalid_type_error: "cursor must be a string" })
      .min(1, "cursor must not be empty when provided")
      .optional(),
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .optional(),
  })
  .strict();

export type DlqQuery = z.infer<typeof dlqQuerySchema>;

/**
 * Schema for POST /api/admin/webhooks/dlq/:id/replay route parameters.
 */
export const dlqReplayParamsSchema = z.object({
  id: z
    .string({ invalid_type_error: "id must be a string" })
    .uuid("id must be a valid UUID"),
});

export type DlqReplayParams = z.infer<typeof dlqReplayParamsSchema>;
