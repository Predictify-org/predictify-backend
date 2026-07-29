import { z } from "zod";
import { DEFAULT_PAGE_SIZE } from "../utils/cursor";

/**
 * Zod schema for a valid Stellar public key (56-char G… address).
 *
 * Stellar public keys are 32-byte Ed25519 keys encoded as base-32 with a
 * leading 'G' version byte, producing exactly 56 characters using the
 * alphabet A–Z and 2–7 (standard RFC 4648 base-32, no padding).
 */
export const stellarAddressSchema = z
  .string({
    required_error: "Stellar address is required",
    invalid_type_error: "Stellar address must be a string",
  })
  .trim()
  .regex(/^G[A-Z2-7]{55}$/, {
    message: "Invalid Stellar address: must be a 56-character G-prefixed base-32 public key",
  });

export type StellarAddress = z.infer<typeof stellarAddressSchema>;

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

/**
 * Query parameters for GET /api/users (cursor-paginated user list).
 *
 * Unknown query parameters are rejected via `.strict()` so the route
 * boundary is explicit and malformed input is never silently ignored.
 */
export const listUsersQuerySchema = z
  .object({
    cursor: z
      .string({
        invalid_type_error: "cursor must be a string",
      })
      .trim()
      .min(1, "cursor must be a non-empty string when provided")
      .optional(),
    limit: z.coerce
      .number({
        invalid_type_error: "limit must be a number",
      })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/users/:address/predictions
// ---------------------------------------------------------------------------

/**
 * Route parameters for the user-predictions endpoint.
 *   :address — a valid 56-char Stellar G-address
 */
export const userPredictionsParamsSchema = z
  .object({
    address: stellarAddressSchema,
  })
  .strict();

export type UserPredictionsParams = z.infer<typeof userPredictionsParamsSchema>;

/**
 * Query parameters for GET /api/users/:address/predictions.
 *
 * Unknown query parameters are rejected via `.strict()` so the route
 * boundary is explicit and malformed input is never silently ignored.
 */
export const userPredictionsQuerySchema = z
  .object({
    status: z
      .enum(["pending", "confirmed", "won", "lost", "claimed"], {
        invalid_type_error: "status must be a string",
        message: "status must be one of: pending, confirmed, won, lost, claimed",
      })
      .optional(),
    cursor: z
      .string({
        invalid_type_error: "cursor must be a string",
      })
      .trim()
      .min(1, "cursor must be a non-empty string when provided")
      .optional(),
    limit: z.coerce
      .number({
        invalid_type_error: "limit must be a number",
      })
      .int("limit must be an integer")
      .min(1, "limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type UserPredictionsQuery = z.infer<typeof userPredictionsQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/users/:stellarAddress/profile
// ---------------------------------------------------------------------------

/**
 * Route parameters for the public user-profile endpoint.
 *   :stellarAddress — a valid 56-char Stellar G-address
 */
export const userProfileParamsSchema = z
  .object({
    stellarAddress: stellarAddressSchema,
  })
  .strict();

export type UserProfileParams = z.infer<typeof userProfileParamsSchema>;

// ---------------------------------------------------------------------------
// GET /api/users/:addr/portfolio (sub-router)
// ---------------------------------------------------------------------------

/**
 * Route parameters for the user-portfolio endpoint.
 *   :addr — a valid 56-char Stellar G-address
 */
export const userPortfolioParamsSchema = z
  .object({
    addr: stellarAddressSchema,
  })
  .strict();

export type UserPortfolioParams = z.infer<typeof userPortfolioParamsSchema>;
