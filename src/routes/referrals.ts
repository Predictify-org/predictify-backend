/**
 * @module routes/referrals
 *
 * Referral code management endpoints.
 *
 *   POST   /api/referrals   — create a new referral code
 *   GET    /api/referrals   — list referrals for the authenticated user
 *
 * Security
 * ────────
 * Both endpoints require a valid JWT via the `requireAuth` middleware.
 * Unauthenticated callers receive 401.
 *
 * Audit
 * ─────
 * POST (mutation) writes a structured row to `audit_logs` via `createAuditLog`.
 * The row captures:
 *   • action        — "referral.create"
 *   • walletAddress — the authenticated user's Stellar address (actor)
 *   • ip            — resolved from x-forwarded-for or socket
 *   • correlationId — forwarded from AsyncLocalStorage / request id
 *   • beforeState   — null (nothing to capture before creation)
 *   • afterState    — { referralCode: "<code>", campaignId: "..." }
 *
 * Rate limiting
 * ─────────────
 * Shared per-user rate limiter (60 req/min) on all routes.
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in `ReferralsRouterDeps` so tests can
 * substitute fully-controlled stubs without network or DB access.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { logger } from "../config/logger";
import { requireAuth } from "../middleware/requireAuth";
import type { AuthenticatedRequest } from "../middleware/auth";
import { CORRELATION_ID_HEADER } from "../lib/http";
import { getCorrelationId } from "../middleware/correlation";
import { createAuditLog } from "../services/auditService";
import {
  createReferral,
  listUserReferrals,
  type ReferralServiceDeps,
} from "../services/referralService";

// ── Validation ────────────────────────────────────────────────────────────────

/** Body accepted by POST /api/referrals. */
const createReferralBodySchema = z.object({
  campaignId: z.string().optional(),
});

// ── Injectable dependency interface ──────────────────────────────────────────

export interface ReferralsRouterDeps {
  /** Create a referral code (defaults to referralService.createReferral). */
  createReferral?: ReferralServiceDeps["createReferral"];
  /** List user referrals (defaults to referralService.listUserReferrals). */
  listUserReferrals?: ReferralServiceDeps["listUserReferrals"];
  /** Persist an audit log entry (defaults to createAuditLog). */
  auditLogger?: typeof createAuditLog;
}

// ── Router options ────────────────────────────────────────────────────────────

export interface ReferralsRouterOptions {
  /** Maximum requests per minute per user. Defaults to 60. */
  rateLimitPerMinute?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the correlation ID from AsyncLocalStorage, then fall back to req.id. */
function resolveCorrelationId(req: { id?: unknown }): string {
  return (
    getCorrelationId() ??
    (typeof req.id === "string" ? req.id : "") ??
    ""
  );
}

/** Extract the client IP from forwarded headers or the socket. */
function extractClientIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0] ?? "unknown";
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the /api/referrals router with injected dependencies.
 *
 * @param opts.rateLimitPerMinute  - Requests per minute per user (default 60).
 * @param deps.createReferral      - Override referral creator (tests only).
 * @param deps.listUserReferrals   - Override referral lister (tests only).
 * @param deps.auditLogger         - Override audit logger (tests only).
 */
export function createReferralsRouter(
  opts: ReferralsRouterOptions = {},
  deps: ReferralsRouterDeps = {},
): Router {
  const rpmLimit = opts.rateLimitPerMinute ?? 60;
  const createReferralFn = deps.createReferral ?? createReferral;
  const listUserReferralsFn = deps.listUserReferrals ?? listUserReferrals;
  const auditLoggerFn = deps.auditLogger ?? createAuditLog;

  const router = Router();

  // ── Rate limiter ─────────────────────────────────────────────────────────
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: rpmLimit,
      keyGenerator: (req) => {
        const userId = (req as AuthenticatedRequest).user?.id;
        if (typeof userId === "string" && userId.trim().length > 0) {
          return `referrals:${userId}`;
        }
        return `referrals:ip:${req.ip ?? "unknown"}`;
      },
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Auth guard ──────────────────────────────────────────────────────────
  router.use(requireAuth);

  // ── POST /api/referrals ─────────────────────────────────────────────────
  /**
   * Create a new referral code for the authenticated user.
   *
   * Request body: { "campaignId"?: string }
   *
   * Response 201: { "data": { "referralCode": "REF-XXXX-XXXX", "message": "…" } }
   */
  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const correlationId = resolveCorrelationId(req);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);

      const parsed = createReferralBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            details: parsed.error.issues,
            correlationId,
          },
        });
      }

      const { campaignId } = parsed.data;
      const userId = (req as AuthenticatedRequest).user!.id;

      // Capture before-state (null — no state to capture before creation)
      const beforeState = null;

      // Persist the referral
      const result = await createReferralFn({ userId, campaignId });

      const afterState = { referralCode: result.referralCode, campaignId: campaignId ?? null };

      // Audit log — fire-and-forget (errors are caught inside auditService)
      const ip = extractClientIp(req);
      await auditLoggerFn({
        action: "referral.create",
        walletAddress: (req as AuthenticatedRequest).user?.stellarAddress ?? undefined,
        ip,
        correlationId,
        beforeState,
        afterState,
      });

      logger.info(
        {
          correlationId,
          userId,
          referralCode: result.referralCode,
          campaignId,
        },
        "referral_created",
      );

      return res.status(201).json({
        data: result,
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── GET /api/referrals ──────────────────────────────────────────────────
  /**
   * List all referrals for the authenticated user.
   *
   * Response 200: { "data": Referral[] }
   */
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const correlationId = resolveCorrelationId(req);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);

      const userId = (req as AuthenticatedRequest).user!.id;

      const userReferrals = await listUserReferralsFn(userId);

      logger.info(
        {
          correlationId,
          userId,
          count: userReferrals.length,
        },
        "referrals_listed",
      );

      return res.json({
        data: userReferrals.map((r) => ({
          id: r.id,
          referredUser: r.referredUser,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** Default singleton wired into src/index.ts. */
export const referralsRouter = createReferralsRouter();
