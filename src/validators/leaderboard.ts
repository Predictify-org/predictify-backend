import { z } from "zod";
import { stellarAddressSchema } from "./users";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export enum LeaderboardPeriod {
  ALL_TIME = "all-time",
  MONTHLY = "monthly",
  WEEKLY = "weekly",
}

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// ---------------------------------------------------------------------------

/**
 * Query parameters for GET /api/leaderboard.
 *
 * Unknown query parameters are rejected via `.strict()` so the route
 * boundary is explicit and malformed input is never silently ignored.
 */
export const leaderboardQuerySchema = z
  .object({
    limit: z.coerce
      .number({
        invalid_type_error: "limit must be a number",
      })
      .int("limit must be an integer")
      .positive("limit must be between 1 and 100")
      .max(100, "limit must be between 1 and 100")
      .default(50),
    offset: z.coerce
      .number({
        invalid_type_error: "offset must be a number",
      })
      .int("offset must be an integer")
      .nonnegative("offset must be a non-negative integer")
      .default(0),
    refresh: z.preprocess(
      (v) => {
        if (typeof v === "string") {
          if (v === "true" || v === "1") return true;
          if (v === "false" || v === "0") return false;
        }
        return v;
      },
      z.boolean().default(false),
    ),
    period: z
      .nativeEnum(LeaderboardPeriod, {
        errorMap: () => ({
          message:
            "period must be one of: all-time, monthly, weekly",
        }),
      })
      .default(LeaderboardPeriod.ALL_TIME),
  })
  .strict();

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/leaderboard/user/:stellarAddress
// ---------------------------------------------------------------------------

/**
 * Route parameters for the user leaderboard entry endpoint.
 *   :stellarAddress — a valid 56-char Stellar G-address
 */
export const leaderboardUserParamsSchema = z
  .object({
    stellarAddress: stellarAddressSchema,
  })
  .strict();

export type LeaderboardUserParams = z.infer<typeof leaderboardUserParamsSchema>;

/**
 * Query parameters for GET /api/leaderboard/user/:stellarAddress.
 *
 * Unknown query parameters are rejected via `.strict()` so the route
 * boundary is explicit and malformed input is never silently ignored.
 */
export const leaderboardUserQuerySchema = z
  .object({
    period: z
      .nativeEnum(LeaderboardPeriod, {
        errorMap: () => ({
          message:
            "period must be one of: all-time, monthly, weekly",
        }),
      })
      .default(LeaderboardPeriod.ALL_TIME),
  })
  .strict();

export type LeaderboardUserQuery = z.infer<typeof leaderboardUserQuerySchema>;
