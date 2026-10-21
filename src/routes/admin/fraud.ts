import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from "../../lib/http";
import { getCorrelationId } from "../../middleware/correlation";
import {
  DrizzleFraudRepo,
  type FraudFlagDTO,
  type FraudRepo,
  listFraudFlags,
  runFraudScan,
} from "../../services/fraudService";
import { createAuditLog } from "../../services/auditService";
import { AppError, ValidationError } from "../../errors";

const listQuerySchema = z.object({
  status: z.enum(["open", "dismissed", "confirmed"]).optional(),
  limit: z
    .string()
    .regex(/^\d+$/u, { message: "limit must be a positive integer" })
    .transform((v) => parseInt(v, 10))
    .refine((n) => n >= 1 && n <= 200, {
      message: "limit must be between 1 and 200",
    })
    .optional(),
});

const scanBodySchema = z
  .object({
    lookbackMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
    maxPredictions: z.number().int().positive().max(100_000).optional(),
  })
  .strict();

/**
 * Review transitions accepted by PATCH /flags/:id.
 *
 *   open       → confirmed | dismissed
 *   confirmed  → dismissed (note required)
 *
 * Everything else — including dismissed → confirmed — answers 409
 * `invalid_transition`.
 */
const reviewBodySchema = z
  .object({
    status: z.enum(["confirmed", "dismissed"]),
    note: z.string().min(1).max(4000).optional(),
  })
  .strict();

type FlagStatus = "open" | "confirmed" | "dismissed";

function canTransition(from: FlagStatus, to: FlagStatus): boolean {
  if (from === "open") return to === "confirmed" || to === "dismissed";
  if (from === "confirmed") return to === "dismissed";
  return false; // dismissed is terminal for this workflow
}

function reviewState(flag: FraudFlagDTO): Record<string, unknown> {
  return {
    id: flag.id,
    clusterKey: flag.clusterKey,
    userId: flag.userId,
    stellarAddress: flag.stellarAddress,
    reason: flag.reason,
    score: flag.score,
    status: flag.status,
    reviewedBy: flag.reviewedBy,
    reviewedAt: flag.reviewedAt instanceof Date ? flag.reviewedAt.toISOString() : flag.reviewedAt,
    carriedFrom: flag.carriedFrom ?? null,
    correlationId: flag.correlationId,
  };
}

export interface AdminFraudRouterOptions {
  repo?: FraudRepo;
  rateLimitPerMinute?: number;
}

function requestIdOf(req: { id?: unknown }): string {
  return (
    getCorrelationId() ??
    (typeof req.id === "string" ? req.id : "") ??
    ""
  );
}

export function createAdminFraudRouter(
  opts: AdminFraudRouterOptions = {},
): Router {
  const router = Router();
  const repo = opts.repo ?? new DrizzleFraudRepo();
  const limit = opts.rateLimitPerMinute ?? 60;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ??
        req.ip ??
        "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  router.use(requireAdmin);

  router.get("/flags", async (req, res, next) => {
    try {
      const correlationId = requestIdOf({ id: (req as { id?: unknown }).id });
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues[0]?.message ?? "invalid query parameters",
        );
      }
      const rows = await listFraudFlags(parsed.data, repo);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      res.setHeader(REQUEST_ID_HEADER, correlationId);
      res.json({ data: rows, correlationId });
    } catch (e) {
      next(e);
    }
  });

  router.post("/scan", async (req, res, next) => {
    try {
      const correlationId = requestIdOf({ id: (req as { id?: unknown }).id });
      const body = req.body ?? {};
      const parsed = scanBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
      }
      const result = await runFraudScan(repo, {
        ...parsed.data,
        correlationId,
      });
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      res.setHeader(REQUEST_ID_HEADER, correlationId);
      res.json({ data: result, correlationId });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/flags/:id", async (req, res, next) => {
    try {
      const correlationId = requestIdOf({ id: (req as { id?: unknown }).id });
      const id = req.params.id;
      const parsed = reviewBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
      }
      const target = parsed.data.status;
      const note = parsed.data.note;

      const before = await repo.getFlag(id);
      if (!before) {
        throw AppError.notFound("Fraud flag not found");
      }

      const current = before.status as FlagStatus;
      if (!canTransition(current, target)) {
        throw new AppError(
          "invalid_transition",
          `cannot transition fraud flag from "${current}" to "${target}"`,
          409,
        );
      }
      if (current === "confirmed" && target === "dismissed" && !note) {
        throw new ValidationError(
          "note is required to dismiss a confirmed fraud flag",
        );
      }

      // Optimistic concurrency: the repo re-checks `expectedStatus`, so a
      // competing reviewer loses the race and lands here as a 409.
      const after = await repo.transitionFlag({
        id,
        expectedStatus: current,
        status: target,
        reviewedBy: req.adminAddress ?? "",
        note,
      });
      if (!after) {
        throw new AppError(
          "invalid_transition",
          "fraud flag was modified by another reviewer",
          409,
        );
      }

      await createAuditLog({
        action: "fraud_flag.review",
        walletAddress: req.adminAddress,
        ip: req.ip ?? "unknown",
        correlationId,
        entityType: "FraudFlag",
        entityId: id,
        beforeState: reviewState(before),
        afterState: reviewState(after),
        metadata: note !== undefined ? { note } : undefined,
      });

      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      res.setHeader(REQUEST_ID_HEADER, correlationId);
      res.json({ data: after, correlationId });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const adminFraudRouter = createAdminFraudRouter();
