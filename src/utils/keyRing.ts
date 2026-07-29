/**
 * keyRing.ts
 * ----------
 * Loads the set of JWT signing/verification keys from environment
 * configuration and exposes lookup by `kid` (key ID), enabling zero-downtime
 * JWT key rotation.
 *
 * Env contract
 * ------------
 *   JWT_SECRET     (required, existing) — always loaded as the key with the
 *                  reserved kid "default". Deployments that never set the
 *                  variables below keep working exactly as before.
 *   JWT_KEYS       (optional) — extra keys for rotation, formatted as
 *                  comma-separated "kid:secret" pairs (see jwtKeyFormat.ts),
 *                  e.g. "2026-07-01:7f3c9c2c...,2026-06-01:a91e7b54...".
 *                  Each secret must be >= 32 characters; kids must be unique
 *                  (the kid "default" is reserved for JWT_SECRET).
 *   JWT_ACTIVE_KID (optional) — kid used to sign *new* tokens. Defaults to
 *                  "default". Must reference a key loaded above.
 *
 * Verification accepts a token signed by ANY loaded key (active or
 * retired), so tokens issued before a rotation remain valid until they
 * expire naturally — rotating keys never invalidates outstanding tokens.
 *
 * The ring is built once per process (mirrors the eager, fail-fast parsing
 * `env.ts` already does) and memoized; tests that need a different
 * configuration follow the repo convention of `jest.resetModules()` after
 * changing `process.env`.
 */
import { env } from "../config/env";
import { DEFAULT_KID, parseJwtKeysEnv, type JwtKey } from "./jwtKeyFormat";

export { DEFAULT_KID };
export type { JwtKey };

export interface KeyRing {
  activeKid: string;
  keys: ReadonlyMap<string, JwtKey>;
}

function buildKeyRing(): KeyRing {
  const keys = new Map<string, JwtKey>();
  keys.set(DEFAULT_KID, { kid: DEFAULT_KID, secret: env.JWT_SECRET });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jwtKeys = (env as any).JWT_KEYS as string | undefined;
  if (jwtKeys && jwtKeys.trim().length > 0) {
    for (const key of parseJwtKeysEnv(jwtKeys)) {
      if (keys.has(key.kid)) {
        throw new Error(
          `Duplicate kid "${key.kid}" in JWT_KEYS (kid "${DEFAULT_KID}" is reserved for JWT_SECRET)`,
        );
      }
      keys.set(key.kid, key);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeKid = ((env as any).JWT_ACTIVE_KID as string | undefined)?.trim() || DEFAULT_KID;
  if (!keys.has(activeKid)) {
    throw new Error(
      `JWT_ACTIVE_KID "${activeKid}" does not match any loaded JWT key. Loaded kids: ${[...keys.keys()].join(", ")}`,
    );
  }

  return { activeKid, keys };
}

// Built eagerly, once per module instance — mirrors env.ts's own eager,
// fail-fast `schema.parse(process.env)`. A malformed JWT_KEYS or a
// JWT_ACTIVE_KID that names no loaded key crashes on boot, not mid-request.
const ring: KeyRing = buildKeyRing();

/** Returns the process-wide key ring. */
export function getKeyRing(): KeyRing {
  return ring;
}

/** Returns the key currently used to sign new tokens. */
export function getSigningKey(): JwtKey {
  const ring = getKeyRing();
  return ring.keys.get(ring.activeKid)!;
}

/**
 * Looks up a key by kid for verification. Tokens without a `kid` header
 * (issued before key rotation existed) are verified against "default".
 * Returns undefined when the kid is unrecognized (e.g. a retired/unknown key).
 */
export function getVerificationKey(kid: string | undefined): JwtKey | undefined {
  const ring = getKeyRing();
  return ring.keys.get(kid || DEFAULT_KID);
}

/** All currently loaded kids, in load order. Used by diagnostics and the rotation script. */
export function listKids(): string[] {
  return [...getKeyRing().keys.keys()];
}

/** The kid currently used to sign new tokens. */
export function getActiveKid(): string {
  return getKeyRing().activeKid;
}
