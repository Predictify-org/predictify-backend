/**
 * requireAuth / optionalAuth
 * --------------------------
 * Single source of truth for "this request is authenticated as Stellar address X".
 *
 * Usage
 * -----
 *   import { requireAuth, optionalAuth } from "../middleware/requireAuth";
 *
 *   // Protected route — returns 401 when token is absent or invalid
 *   router.post("/predictions", requireAuth, handler);
 *
 *   // Personalised but public route — req.user may be undefined
 *   router.get("/markets", optionalAuth, handler);
 *
 * JWT contract
 * ------------
 *   Tokens must be signed with HS256 (HMAC-SHA256) using a key from the
 *   key ring (src/utils/keyRing.ts), selected by the `kid` header claim.
 *   This allows signing keys to rotate without invalidating outstanding
 *   tokens — see docs/jwt-rotation.md.
 *   Required claims:
 *     - iss  === env.JWT_ISSUER    (e.g. "predictify")
 *     - aud  === env.JWT_AUDIENCE  (e.g. "predictify-app")
 *     - sub  === users.stellar_address
 *   Optional but expected:
 *     - exp  (verified automatically by jsonwebtoken)
 *
 * Hot-path notes
 * --------------
 *   Only a single indexed DB look-up is performed (users.stellar_address has
 *   a UNIQUE index). No external I/O otherwise.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { users } from "../db/schema";
import { verifyAccessToken } from "../services/jwtService";

// ---------------------------------------------------------------------------
// Shared DB pool (module-level singleton — one pool for the whole process).
// In tests this module is imported fresh per-suite so the pool stays small.
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool);

/**
 * Closes this module's own pg Pool. Only needed by test suites that exercise
 * requireAuth/optionalAuth directly against a short-lived database (e.g. a
 * Testcontainers Postgres instance) — call it in `afterAll` alongside
 * `closeDb()` so no connection is left open when the container is torn down.
 * Production code has no reason to call this; the pool lives for the process.
 */
export async function closeAuthPool(): Promise<void> {
  await pool.end();
}

// ---------------------------------------------------------------------------
// Internal helper — resolves with req.user value or throws an AppError.
// Extracted so that both requireAuth and optionalAuth share the same logic.
// ---------------------------------------------------------------------------
interface AuthPayload extends JwtPayload {
  sub: string; // Stellar address
}

/** A lightweight typed error used only inside this module. */
class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string = "unauthenticated",
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Extracts the Bearer token from the Authorization header.
 * Returns the raw JWT string or throws an AuthError.
 */
function extractBearerToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header");
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new AuthError("Empty Bearer token");
  }
  return token;
}

/**
 * Verifies the JWT and returns the decoded payload.
 * Throws an AuthError for expired, forged, or wrong-audience tokens.
 */
function verifyToken(token: string): AuthPayload {
  let payload: JwtPayload | string;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    // Map jsonwebtoken error names to a single stable code so callers don't
    // need to inspect the message string.
    const name = (err as Error).name;
    if (name === "TokenExpiredError") {
      throw new AuthError("Token has expired", "unauthenticated");
    }
    // JsonWebTokenError covers bad signature, wrong issuer, wrong audience, etc.
    throw new AuthError("Invalid token", "unauthenticated");
  }

  // jwt.verify returns a string only when `complete: false` AND the header
  // algorithm is "none". Our options pin HS256 so this branch is unreachable,
  // but narrowing keeps TypeScript happy.
  if (typeof payload === "string" || !payload.sub) {
    throw new AuthError("Token payload is missing subject", "unauthenticated");
  }

  return payload as AuthPayload;
}

/**
 * Loads the user row from the database by Stellar address.
 * The look-up uses the unique index on `stellar_address` — O(log n) I/O.
 * Throws an AuthError when no matching user exists (token is valid but the
 * account has been deleted, for example).
 */
async function loadUser(stellarAddress: string): Promise<Request["user"]> {
  const rows = await db
    .select({ id: users.id, stellarAddress: users.stellarAddress })
    .from(users)
    .where(eq(users.stellarAddress, stellarAddress))
    .limit(1);

  if (rows.length === 0) {
    throw new AuthError("User not found", "unauthenticated");
  }

  return rows[0];
}

/**
 * Core authentication flow shared by both middleware variants.
 *
 * @returns The hydrated user object, or throws an AuthError.
 */
async function authenticate(req: Request): Promise<NonNullable<Request["user"]>> {
  const token = extractBearerToken(req);
  const payload = verifyToken(token);
  const user = await loadUser(payload.sub);
  return user!;
}

// ---------------------------------------------------------------------------
// Public middleware
// ---------------------------------------------------------------------------

/**
 * `requireAuth` — protects a route; rejects unauthenticated requests.
 *
 * On success  → calls `next()` with `req.user` populated.
 * On failure  → responds 401 `{ error: { code: "unauthenticated" } }` and
 *               does NOT call `next()`.
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    req.user = await authenticate(req);
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn(
        { path: req.path, method: req.method, reason: err.message },
        "auth_rejected",
      );
      res.status(err.status).json({ error: { code: err.code } });
      return;
    }
    // Unexpected errors (e.g. DB unavailable) bubble to the global error handler.
    next(err);
  }
};

/**
 * `requireAuthForbidden` — same as `requireAuth` but replies with **HTTP 403**
 * for any authentication failure (missing/expired/forged token, unknown user)
 * and uses the error code `"forbidden"` instead of `"unauthenticated"`.
 *
 * Use this on routes whose issue spec / acceptance criteria requires 403 for
 * anonymous callers (for example `GET /api/users/me`).  Strictly preserving
 * 401 for those routes would deviate from the documented contract, even
 * though RFC 7231 puts "401 unauthenticated" and "403 forbidden" on a
 * continuum that real-world services routinely blur.
 *
 * Flow mirrors `requireAuth` 1:1 so the only observable difference is the
 * status line and error code.  All non-auth errors still bubble up to the
 * global error handler unchanged.
 */
export const requireAuthForbidden: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    req.user = await authenticate(req);
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn(
        { path: req.path, method: req.method, reason: err.message },
        "auth_rejected_forbidden",
      );
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }
    next(err);
  }
};

/**
 * `optionalAuth` — personalises a route without requiring authentication.
 *
 * On valid token   → `req.user` is populated, `next()` is called.
 * On missing token → `req.user` stays `undefined`, `next()` is called.
 * On invalid token → responds 401 so clients know their token is broken and
 *                    can re-authenticate rather than silently receiving a
 *                    de-personalised response.
 */
export const optionalAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  // No header at all → treat as anonymous, continue.
  if (!authHeader) {
    next();
    return;
  }

  // Header present → validate fully; a broken token is still an error.
  try {
    req.user = await authenticate(req);
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn(
        { path: req.path, method: req.method, reason: err.message },
        "auth_rejected",
      );
      res.status(err.status).json({ error: { code: err.code } });
      return;
    }
    next(err);
  }
};
