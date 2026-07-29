import { z } from "zod";

/**
 * Schema for GET /api/markets query parameters.
 *
 * Unknown query parameters are rejected via `.strict()` to keep the route
 * boundary explicit and to avoid silently ignoring malformed input.
 */
export const listMarketsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be between 1 and 100")
      .max(100, "Limit must be between 1 and 100")
      .default(20),
    cursor: z
      .string({ invalid_type_error: "cursor must be a string" })
      .max(512, "cursor is too long")
      .optional(),
    status: z
      .string({ invalid_type_error: "status must be a string" })
      .trim()
      .max(32, "status must be at most 32 characters")
      .optional(),
    category: z
      .string({ invalid_type_error: "category must be a string" })
      .trim()
      .max(64, "category must be at most 64 characters")
      .optional(),
    tag: z
      .string({ invalid_type_error: "tag must be a string" })
      .trim()
      .max(64, "tag must be at most 64 characters")
      .optional(),
    sort: z
      .string({ invalid_type_error: "sort must be a string" })
      .trim()
      .max(32, "sort must be at most 32 characters")
      .optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

export type ListMarketsQuery = z.infer<typeof listMarketsQuerySchema>;

/**
 * Schema for GET /api/markets/search query parameters.
 *
 * Unknown query parameters are rejected via `.strict()`.
 */
export const searchMarketsQuerySchema = z
  .object({
    q: z
      .string({
        required_error: "Search query parameter 'q' is required",
        invalid_type_error: "q must be a string",
      })
      .trim()
      .min(1, "Search query parameter 'q' is required")
      .max(256, "Search query must be at most 256 characters"),
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be between 1 and 100")
      .max(100, "Limit must be between 1 and 100")
      .default(20),
    offset: z.coerce
      .number({ invalid_type_error: "offset must be a number" })
      .int("Offset must be an integer")
      .min(0, "Offset must be non-negative")
      .optional(),
    page: z.coerce
      .number({ invalid_type_error: "page must be a number" })
      .int("Page must be an integer")
      .min(1, "Page must be at least 1")
      .optional(),
  })
  .strict();

export type SearchMarketsQuery = z.infer<typeof searchMarketsQuerySchema>;

/**
 * Schema for GET /api/markets/featured query parameters.
 *
 * Unknown query parameters are rejected via `.strict()`.
 */
export const featuredMarketsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer between 1 and 20")
      .min(1, "limit must be an integer between 1 and 20")
      .max(20, "limit must be an integer between 1 and 20")
      .optional(),
  })
  .strict();

export type FeaturedMarketsQuery = z.infer<typeof featuredMarketsQuerySchema>;

/**
 * Schema for GET /api/markets/upcoming query parameters.
 *
 * Unknown query parameters are rejected via `.strict()`.
 */
export const upcomingMarketsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be between 1 and 100")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(50),
  })
  .strict();

export type UpcomingMarketsQuery = z.infer<typeof upcomingMarketsQuerySchema>;

/**
 * Schema for GET /api/markets/trending query parameters.
 *
 * Unknown query parameters are rejected via `.strict()`.
 */
export const trendingQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("limit must be an integer")
      .positive("limit must be positive")
      .max(100, "limit must be at most 100")
      .default(20),
    offset: z.coerce
      .number({ invalid_type_error: "offset must be a number" })
      .int("offset must be an integer")
      .nonnegative("offset must be non-negative")
      .default(0),
  })
  .strict();

export type TrendingQuery = z.infer<typeof trendingQuerySchema>;

/**
 * Schema for route parameters containing market ID (:id).
 */
export const marketParamsSchema = z.object({
  id: z
    .string({ invalid_type_error: "market ID must be a string" })
    .trim()
    .min(1, "Market ID is required")
    .max(255, "Market ID is too long"),
});

export type MarketParams = z.infer<typeof marketParamsSchema>;

/**
 * Schema for PATCH /api/markets/:id body payload.
 *
 * Uses `.strict()` to reject unexpected fields.
 */
export const patchMarketBodySchema = z
  .object({
    question: z
      .string({ invalid_type_error: "question must be a string" })
      .trim()
      .min(1, "Question cannot be empty")
      .max(512, "Question must be at most 512 characters")
      .optional(),
    metadata: z.record(z.unknown()).optional(),
    expectedVersion: z
      .number({
        required_error: "expectedVersion is required",
        invalid_type_error: "expectedVersion must be a number",
      })
      .int("expectedVersion must be an integer")
      .nonnegative("expectedVersion must be non-negative"),
  })
  .strict();

export type PatchMarketBody = z.infer<typeof patchMarketBodySchema>;

/**
 * Schema for POST /api/markets body payload (admin only).
 *
 * Creates an off-chain market shell with canonical question, metadata, and resolution time.
 * Keyed by on-chain ID supplied by the contract deployer.
 *
 * Uses `.strict()` to reject unexpected fields.
 */
export const createMarketBodySchema = z
  .object({
    id: z
      .string({ invalid_type_error: "id must be a string" })
      .trim()
      .min(1, "Market ID cannot be empty")
      .max(255, "Market ID must be at most 255 characters"),
    question: z
      .string({ invalid_type_error: "question must be a string" })
      .trim()
      .min(1, "Question cannot be empty")
      .max(512, "Question must be at most 512 characters"),
    resolutionTime: z
      .string({ invalid_type_error: "resolutionTime must be an ISO 8601 string" })
      .datetime({ message: "resolutionTime must be a valid ISO 8601 datetime" }),
    metadata: z
      .record(z.unknown())
      .optional()
      .refine(
        (val) => !val || JSON.stringify(val).length <= 65536,
        "Metadata payload must not exceed 64KB when serialized",
      ),
  })
  .strict();

export type CreateMarketBody = z.infer<typeof createMarketBodySchema>;

/**
 * Schema for GET /api/markets/:id/watchers query parameters
 */
export const marketWatchersQuerySchema = z.object({
  limit: z.coerce.number().int("Limit must be an integer").min(1, "Limit must be between 1 and 100").max(100, "Limit must be between 1 and 100").default(20),
  cursor: z.string().optional(),
});

export type MarketWatchersQuery = z.infer<typeof marketWatchersQuerySchema>;

/**
 * Schema for GET /api/markets/recommendations query parameters.
 *
 * Unknown query parameters are rejected via `.strict()`.
 */
export const recommendationsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "limit must be a number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be between 1 and 100")
      .max(100, "Limit must be between 1 and 100")
      .default(20),
    cursor: z
      .string({ invalid_type_error: "cursor must be a string" })
      .max(512, "cursor is too long")
      .optional(),
  })
  .strict();

export type RecommendationsQuery = z.infer<typeof recommendationsQuerySchema>;


