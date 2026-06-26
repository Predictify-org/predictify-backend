/**
 * Admin user-read router.
 *
 * GET /api/admin/users/:address
 *   Returns the aggregated view of a user's predictions, claims, and disputes.
 *   Requires a valid admin JWT (role: "admin") in the Authorization header.
 *   Writes one row to admin_audit_log on every authorised call.
 *   Rate-limited to 60 requests per minute per admin token.
 *
 * The rate-limit ceiling is injectable via createAdminUsersRouter() so tests
 * can exercise the 429 path without firing 60 real requests.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAdmin } from "../middleware/requireAdmin";
import { getAdminUserView, writeAuditLog } from "../services/adminUsersService";
import { db } from "../db/client";

export interface AdminRouterOptions {
  /** Requests per minute per admin token. Default: 60 */
  rateLimitPerMinute?: number;
}

export function createAdminUsersRouter(opts: AdminRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

  // ── Rate limiter ────────────────────────────────────────────────────────────
  // Key on the raw Authorization header so each distinct admin token gets its
  // own bucket.  Falls back to IP for unauthenticated requests so they are
  // still throttled before reaching requireAdmin.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ─────────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── GET /api/admin/users/:address ───────────────────────────────────────────
  router.get("/:address", async (req, res, next) => {
    try {
      const { address } = req.params;
      const adminAddress = req.adminAddress!;

      const view = await getAdminUserView(address, db);

      // Audit every authorised read, including unknown addresses — support staff
      // need to know what was looked up even when the address has no account yet.
      await writeAuditLog(adminAddress, address, db);

      res.json({ data: view });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Default export wired into src/index.ts
export const adminUsersRouter = createAdminUsersRouter();
