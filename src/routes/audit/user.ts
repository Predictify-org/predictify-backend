/**
 * @module routes/audit/user
 *
 * GET /api/audit/user/:addr
 *
 * Returns paginated audit log entries for a single wallet address.
 * Only the authenticated user may query their own address, or an admin
 * may query any address.
 *
 * Security
 * --------
 * - Requires a valid Bearer JWT (`requireAuth`).
 * - Non-admin callers receive 403 if `:addr` does not match their own
 *   `req.user.stellarAddress`.
 * - `:addr` is validated against the Stellar public-key format
 *   (G + 55 base-32 uppercase characters) before any DB access.
 *
 * Pagination
 * ----------
 * Uses the same opaque keyset cursor as the admin audit endpoint
 * (`(created_at DESC, id DESC)`).  See docs/audit-log-pagination.md.
 *
 * Rate limiting
 * -------------
 * 60 requests / minute per JWT (falls back to IP when the header is absent).
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../../middleware/requireAuth";
import { getAuditLogsByUser } from "../../repositories/auditLogRepo";
import { getCorrelationId } from "../../middleware/correlation";
import { logger } from "../../config/logger";
import { RouteErrorFactory } from "../../errors";

// ── Stellar public-key pattern: G followed by exactly 55 base-32 uppercase chars ──
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** Zod schema for the `:addr` path parameter. */
const addrParamSchema = z.object({
  addr: z
    .string()
    .regex(STELLAR_ADDRESS_RE, {
      message: "addr must be a valid Stellar public key (G + 55 base-32 characters)",
    }),
});

/** Zod schema for query-string parameters. */
const userAuditQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z
      .string()
      .regex(/^\d+$/, { message: "limit must be a positive integer" })
      .transform((val) => parseInt(val, 10))
      .optional(),
    action: z.string().optional(),
    startDate: z
      .string()
      .datetime({ message: "startDate must be a valid ISO 8601 datetime string" })
      .transform((val) => new Date(val))
      .optional(),
    endDate: z
      .string()
      .datetime({ message: "endDate must be a valid ISO 8601 datetime string" })
      .transform((val) => new Date(val))
      .optional(),
  })
  .strict();

export interface UserAuditRouterOptions {
  /** Requests per minute per token/IP. Defaults to 60. */
  rateLimitPerMinute?: number;
}

/**
 * Factory — creates the user audit router with injectable options.
 * The factory pattern mirrors the rest of the audit sub-routes and
 * allows tests to configure rate-limit overrides without touching globals.
 */
export function createUserAuditRouter(
  opts: UserAuditRouterOptions = {},
): Router {
  const router = Router({ mergeParams: true });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute ?? 60,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Authentication ─────────────────────────────────────────────────────────
  router.use(requireAuth);

  /**
   * @openapi
   * /api/audit/user/{addr}:
   *   get:
   *     summary: Per-user audit history
   *     description: >
   *       Returns paginated audit log entries for the given Stellar wallet
   *       address. Authenticated users may only query their own address;
   *       admins (role=admin) may query any address.
   *     operationId: getUserAuditHistory
   *     tags:
   *       - Audit
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: addr
   *         required: true
   *         schema:
   *           type: string
   *         description: Stellar public key (G + 55 base-32 uppercase chars)
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *         description: Opaque pagination cursor from a previous response
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *         description: Number of records per page (1–100, default 20)
   *       - in: query
   *         name: action
   *         schema:
   *           type: string
   *         description: Filter by exact action string (e.g. "auth.login")
   *       - in: query
   *         name: startDate
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Inclusive lower-bound on createdAt (ISO 8601)
   *       - in: query
   *         name: endDate
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Inclusive upper-bound on createdAt (ISO 8601)
   *     responses:
   *       200:
   *         description: Paginated audit log for the requested address
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserAuditPage'
   *       400:
   *         description: Invalid path or query parameter
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorBody'
   *       401:
   *         description: Missing or invalid Bearer token
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorBody'
   *       403:
   *         description: Authenticated user is not authorised to view this address
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorBody'
   *       422:
   *         description: Unprocessable query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorBody'
   *       429:
   *         description: Rate limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorBody'
   */
  router.get("/:addr", async (req, res, next) => {
    const correlationId = getCorrelationId() ?? "unknown";

    try {
      // ── Validate path parameter ──────────────────────────────────────────
      const paramResult = addrParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        throw RouteErrorFactory.badRequest(
          paramResult.error.issues[0]?.message ??
            "Invalid wallet address format",
        );
      }
      const { addr } = paramResult.data;

      // ── Authorisation: user may only read their own history ──────────────
      // req.user is guaranteed by requireAuth above.
      const caller = req.user!;
      const isAdmin =
        (caller as unknown as { role?: string }).role === "admin";

      if (!isAdmin && caller.stellarAddress !== addr) {
        logger.warn(
          {
            correlationId,
            callerAddress: caller.stellarAddress,
            requestedAddress: addr,
          },
          "user_audit_forbidden",
        );
        throw RouteErrorFactory.forbidden(
          "You are not authorised to view audit logs for this address",
        );
      }

      // ── Validate query string ────────────────────────────────────────────
      const queryResult = userAuditQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw RouteErrorFactory.validation(
          queryResult.error.issues[0]?.message ??
            "Invalid query parameters",
        );
      }
      const filters = queryResult.data;

      logger.info(
        {
          correlationId,
          addr,
          filters: {
            action: filters.action,
            startDate: filters.startDate,
            endDate: filters.endDate,
            limit: filters.limit,
            hasCursor: Boolean(filters.cursor),
          },
          callerAddress: caller.stellarAddress,
        },
        "user_audit_fetch",
      );

      // ── Query ────────────────────────────────────────────────────────────
      const page = await getAuditLogsByUser(addr, filters);

      res.json({ data: page.data, nextCursor: page.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Production router instance wired into src/index.ts. */
export const userAuditRouter = createUserAuditRouter();
