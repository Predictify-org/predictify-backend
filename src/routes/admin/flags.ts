import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { RouteErrorFactory } from "../../errors";
import * as featureFlagsService from "../../services/featureFlags";

export interface AdminFlagsRouterOptions {
  rateLimitPerMinute?: number;
}

const createFlagSchema = z.object({
  key: z.string().min(1, "key is required"),
  enabled: z.boolean(),
  variant: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const updateFlagSchema = z.object({
  enabled: z.boolean().optional(),
  variant: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

export function createAdminFlagsRouter(opts: AdminFlagsRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

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

  router.use(requireAdmin);

  router.get("/", async (_req, res, next) => {
    try {
      const flags = featureFlagsService.getAllFlags();
      res.json({ data: flags });
    } catch (e) {
      next(e);
    }
  });

  router.get("/:key", async (req, res, next) => {
    try {
      const flag = featureFlagsService.getFlag(req.params.key);
      if (!flag) {
        throw RouteErrorFactory.notFound(`Feature flag '${req.params.key}' not found`);
      }
      res.json({ data: flag });
    } catch (e) {
      next(e);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const parseResult = createFlagSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw RouteErrorFactory.validation(parseResult.error.issues[0]?.message ?? "invalid payload");
      }

      const existing = featureFlagsService.getFlag(parseResult.data.key);
      if (existing) {
        throw RouteErrorFactory.conflict(`Feature flag '${parseResult.data.key}' already exists`);
      }

      const newFlag = await featureFlagsService.createFlag(parseResult.data);
      res.status(201).json({ data: newFlag });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/:key", async (req, res, next) => {
    try {
      const parseResult = updateFlagSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw RouteErrorFactory.validation(parseResult.error.issues[0]?.message ?? "invalid payload");
      }

      const updated = await featureFlagsService.updateFlag(req.params.key, parseResult.data);
      if (!updated) {
        throw RouteErrorFactory.notFound(`Feature flag '${req.params.key}' not found`);
      }
      res.json({ data: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/:key", async (req, res, next) => {
    try {
      const deleted = await featureFlagsService.deleteFlag(req.params.key);
      if (!deleted) {
        throw RouteErrorFactory.notFound(`Feature flag '${req.params.key}' not found`);
      }
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const adminFlagsRouter = createAdminFlagsRouter();
