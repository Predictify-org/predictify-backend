import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * Zod schema for a valid Stellar Ed25519 public key (56-char G… address).
 *
 * Stellar public keys are 32-byte Ed25519 keys encoded as base-32 with a
 * leading 'G' version byte, producing exactly 56 characters using the
 * alphabet A–Z and 2–7 (RFC 4648 base-32, no padding).
 *
 * This schema uses StrKey.isValidEd25519PublicKey() from the Stellar SDK
 * for validation against Stellar's canonical format.
 */
const stellarPublicKeySchema = z
  .string({
    required_error: "Stellar address is required",
    invalid_type_error: "Stellar address must be a string",
  })
  .trim()
  .refine((addr) => StrKey.isValidEd25519PublicKey(addr), {
    message: "Invalid Stellar ed25519 public key (must be 56-char G-prefixed base-32 address)",
  });

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/challenge
// ─────────────────────────────────────────────────────────────────────────

/**
 * Request body schema for POST /api/auth/challenge.
 *
 * Creates a new authentication challenge (nonce + expiry) for a given
 * Stellar address. The returned nonce must be signed by the user's private
 * key and submitted to /api/auth/verify along with the address and signature.
 *
 * Example:
 *   POST /api/auth/challenge
 *   { "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }
 */
export const authChallengeBodySchema = z
  .object({
    stellarAddress: stellarPublicKeySchema,
  })
  .strict();

export type AuthChallengeBody = z.infer<typeof authChallengeBodySchema>;

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify
// ─────────────────────────────────────────────────────────────────────────

/**
 * Request body schema for POST /api/auth/verify.
 *
 * Verifies that the provided signature is a valid Ed25519 signature of the
 * nonce using the private key corresponding to the given Stellar address.
 *
 * On success, returns access and refresh tokens for the authenticated user.
 * On failure, returns 422 if the signature is invalid or the nonce has expired.
 *
 * Example:
 *   POST /api/auth/verify
 *   {
 *     "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
 *     "nonce": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
 *     "signature": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
 *   }
 */
export const authVerifyBodySchema = z
  .object({
    stellarAddress: stellarPublicKeySchema,
    nonce: z
      .string({
        required_error: "nonce is required",
        invalid_type_error: "nonce must be a string",
      })
      .trim()
      .min(1, "nonce must be a non-empty string"),
    signature: z
      .string({
        required_error: "signature is required",
        invalid_type_error: "signature must be a string",
      })
      .trim()
      .min(1, "signature must be a non-empty string"),
  })
  .strict();

export type AuthVerifyBody = z.infer<typeof authVerifyBodySchema>;

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────

/**
 * Request body schema for POST /api/auth/refresh.
 *
 * Rotates the refresh token and returns a new access token + refresh token
 * pair. The new refresh token is valid for future rotations; the old one
 * is invalidated, along with all tokens in its family (chain of rotations).
 *
 * Example:
 *   POST /api/auth/refresh
 *   { "refreshToken": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }
 */
export const authRefreshBodySchema = z
  .object({
    refreshToken: z
      .string({
        required_error: "refreshToken is required",
        invalid_type_error: "refreshToken must be a string",
      })
      .trim()
      .min(1, "refreshToken must be a non-empty string"),
  })
  .strict();

export type AuthRefreshBody = z.infer<typeof authRefreshBodySchema>;

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────

/**
 * Request body schema for POST /api/auth/logout.
 *
 * Revokes the entire refresh token family (chain of rotations) associated
 * with the provided token, ensuring all descendants of that token are also
 * invalidated.
 *
 * Example:
 *   POST /api/auth/logout
 *   { "refreshToken": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }
 */
export const authLogoutBodySchema = z
  .object({
    refreshToken: z
      .string({
        required_error: "refreshToken is required",
        invalid_type_error: "refreshToken must be a string",
      })
      .trim()
      .min(1, "refreshToken must be a non-empty string"),
  })
  .strict();

export type AuthLogoutBody = z.infer<typeof authLogoutBodySchema>;

// ─────────────────────────────────────────────────────────────────────────
// POST /api/auth/wallet/logout
// ─────────────────────────────────────────────────────────────────────────

/**
 * Request body schema for POST /api/auth/wallet/logout.
 *
 * Identical to /api/auth/logout; revokes the entire refresh token family.
 * This endpoint is a wallet-specific alias for consistency with client SDKs.
 *
 * Example:
 *   POST /api/auth/wallet/logout
 *   { "refreshToken": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }
 */
export const authWalletLogoutBodySchema = z
  .object({
    refreshToken: z
      .string({
        required_error: "refreshToken is required",
        invalid_type_error: "refreshToken must be a string",
      })
      .trim()
      .min(1, "refreshToken must be a non-empty string"),
  })
  .strict();

export type AuthWalletLogoutBody = z.infer<typeof authWalletLogoutBodySchema>;
