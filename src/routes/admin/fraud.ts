import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { CORRELATION_ID_HEADER } from "../../lib/http";
import { getCorrelationId } from "../../middleware/correlation";
import {
  DrizzleFraudRepo,
  type FraudRepo,
  listFraudFlags,
  runFraudScan,
} from "../../services/fraudService";
import { RouteErrorFactory } from "../../errors";

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
        throw RouteErrorFactory.validation(
          parsed.error.issues[0]?.message ?? "invalid query parameters",
        );
      }
      const rows = await listFraudFlags(parsed.data, repo);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
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
        throw RouteErrorFactory.validation(
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
      }
      const result = await runFraudScan(repo, {
        ...parsed.data,
        correlationId,
      });
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      res.json({ data: result, correlationId });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const adminFraudRouter = createAdminFraudRouter();
