/**
 * jwtKeyFormat.ts
 * ---------------
 * Pure parsing/formatting helpers for the JWT_KEYS env var format
 * ("kid1:secret1,kid2:secret2"). Deliberately has no dependency on app
 * config so it can be reused by the rotation CLI
 * (scripts/rotate-jwt-key.ts) without requiring the full env schema to be
 * valid (DATABASE_URL, SOROBAN_RPC_URL, ...) — only src/utils/keyRing.ts
 * needs that, since it also wires in JWT_SECRET as the reserved "default" key.
 */

/** Reserved kid for the always-present JWT_SECRET key. */
export const DEFAULT_KID = "default";

const MIN_SECRET_LENGTH = 32;
const KID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface JwtKey {
  kid: string;
  secret: string;
}

/** Parses the "kid1:secret1,kid2:secret2" format used by JWT_KEYS. */
export function parseJwtKeysEnv(raw: string): JwtKey[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const sep = entry.indexOf(":");
      if (sep === -1) {
        throw new Error(`JWT_KEYS entry "${entry}" must be in "kid:secret" format`);
      }

      const kid = entry.slice(0, sep).trim();
      const secret = entry.slice(sep + 1).trim();

      if (!kid || !KID_PATTERN.test(kid)) {
        throw new Error(
          `JWT_KEYS kid "${kid}" is invalid — kids may only contain letters, digits, ".", "_", "-"`,
        );
      }
      if (secret.length < MIN_SECRET_LENGTH) {
        throw new Error(
          `JWT_KEYS secret for kid "${kid}" must be at least ${MIN_SECRET_LENGTH} characters`,
        );
      }

      return { kid, secret };
    });
}

/** Serializes keys back to the "kid1:secret1,kid2:secret2" format. */
export function formatJwtKeysEnv(keys: JwtKey[]): string {
  return keys.map((k) => `${k.kid}:${k.secret}`).join(",");
}
