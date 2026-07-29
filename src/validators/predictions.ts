import { z } from "zod";
import { DEFAULT_PAGE_SIZE } from "../utils/cursor";

/**
 * Schema for GET /api/predictions query parameters.
 *
 * Unknown query parameters are rejected to keep the route boundary explicit
 * and to avoid silently ignoring malformed input.
 */
export const listPredictionsQuerySchema = z
  .object({
    marketId: z
      .string({ invalid_type_error: "marketId must be a string" })
      .trim()
      .min(1, "marketId must be a non-empty string")
      .max(128, "marketId must be at most 128 characters")
      .optional(),
    status: z
      .enum(["pending", "confirmed", "won", "lost", "claimed"], {
        message: "status must be one of: pending, confirmed, won, lost, claimed",
      })
      .optional(),
    outcome: z
      .string({ invalid_type_error: "outcome must be a string" })
      .trim()
      .min(1, "outcome must be a non-empty string")
      .max(64, "outcome must be at most 64 characters")
      .optional(),
    cursor: z.string({ invalid_type_error: "cursor must be a string" }).optional(),
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type ListPredictionsQuery = z.infer<typeof listPredictionsQuerySchema>;

/**
 * Schema for route parameters requiring a prediction ID.
 */
export const predictionIdParamSchema = z
  .object({
    id: z.string().uuid("id must be a valid UUID"),
  })
  .strict();

export type PredictionIdParam = z.infer<typeof predictionIdParamSchema>;

/**
 * Schema for GET /api/markets/:id/predictions query parameters.
 */
export const listMarketPredictionsQuerySchema = z
  .object({
    status: z
      .enum(["pending", "confirmed", "won", "lost", "claimed"], {
        message: "status must be one of: pending, confirmed, won, lost, claimed",
      })
      .optional(),
    outcome: z
      .string({ invalid_type_error: "outcome must be a string" })
      .trim()
      .min(1, "outcome must be a non-empty string")
      .max(64, "outcome must be at most 64 characters")
      .optional(),
    cursor: z.string({ invalid_type_error: "cursor must be a string" }).optional(),
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(20),
  })
  .strict();

export type ListMarketPredictionsQuery = z.infer<typeof listMarketPredictionsQuerySchema>;
