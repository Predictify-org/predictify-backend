/**
 * jwtService.ts
 * -------------
 * Single source of truth for signing and verifying Predictify access tokens.
 * Backed by the key ring (src/utils/keyRing.ts) so several signing keys can
 * be active at once, each identified by a `kid` header claim — enabling
 * key rotation without invalidating outstanding tokens.
 *
 *   - signAccessToken always signs with the *active* key and stamps its kid
 *     onto the token header.
 *   - verifyAccessToken reads the unsigned header to find the kid, looks up
 *     the matching key (active or retired), and verifies against it. Tokens
 *     issued before this feature shipped carry no `kid` header; those are
 *     verified against the reserved "default" key (JWT_SECRET) so existing
 *     sessions are unaffected.
 *
 * Throws the same jsonwebtoken error types (`TokenExpiredError`,
 * `JsonWebTokenError`) that `jwt.verify` itself throws, so existing
 * call-site error handling keeps working unchanged.
 */
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import { getSigningKey, getVerificationKey } from "../utils/keyRing";

export type JwtSignPayload = Record<string, unknown> & { sub: string };

/** Signs a new access token with the currently active signing key. */
export function signAccessToken(payload: JwtSignPayload, options: SignOptions = {}): string {
  const { kid, secret } = getSigningKey();
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: env.JWT_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    keyid: kid,
    ...options,
  });
}

/**
 * Verifies an access token against the key its `kid` header names (falling
 * back to the "default" key for tokens with no `kid`). Returns the decoded
 * payload on success.
 *
 * @throws {jwt.TokenExpiredError} when the token has expired.
 * @throws {jwt.JsonWebTokenError} for any other invalid token: bad
 *   signature, wrong issuer/audience, malformed token, or an unrecognized kid.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded !== "string" ? decoded.header.kid : undefined;

  const key = getVerificationKey(kid);
  if (!key) {
    throw new jwt.JsonWebTokenError(`Unrecognized JWT kid: "${kid}"`);
  }

  const payload = jwt.verify(token, key.secret, {
    algorithms: ["HS256"],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  if (typeof payload === "string") {
    throw new jwt.JsonWebTokenError("Unexpected string JWT payload");
  }

  return payload;
}
