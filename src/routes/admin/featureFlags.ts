import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";
import {
  listFeatureFlags,
  getFeatureFlag,
  createFeatureFlag,
  updateFeatureFlag,
  deleteFeatureFlag,
  FeatureFlagConflictError,
  FeatureFlagNotFoundError,
} from "../../services/featureFlagService";
import { RouteErrorFactory } from "../../errors";

export interface AdminFeatureFlagsRouterOptions {
  rateLimitPerMinute?: number;
}

const flagKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "key must be alphanumeric with - or _ separators");

const createSchema = z
  .object({
    key: flagKeySchema,
    enabled: z.boolean(),
    description: z.string().max(280).nullish(),
  })
  .strict();

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    description: z.string().max(280).nullish(),
  })
  .strict()
  .refine((v) => v.enabled !== undefined || v.description !== undefined, {
    message: "at least one of enabled or description is required",
  });

function handleFlagError(res: import("express").Response, e: unknown): boolean {
  if (e instanceof FeatureFlagConflictError || e instanceof FeatureFlagNotFoundError) {
    res.status(e.status).json({
      error: { type: e.code, message: e.message, correlationId: "" },
    });
    return true;
  }
  return false;
}

export function createAdminFeatureFlagsRouter(
  opts: AdminFeatureFlagsRouterOptions = {},
): Router {
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

  router.get("/", (_req, res) => {
    res.json({ data: listFeatureFlags() });
  });

  router.post("/", (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw RouteErrorFactory.validation(parsed.error.issues[0]?.message ?? "invalid body");
    }
    try {
      const flag = createFeatureFlag(parsed.data);
      logger.info({ reqId: getRequestId(), key: flag.key, actor: req.adminAddress }, "feature_flag_created");
      return res.status(201).json({ data: flag });
    } catch (e) {
      if (handleFlagError(res, e)) return;
      return next(e);
    }
  });

  router.get("/:key", (req, res, next) => {
    const key = flagKeySchema.safeParse(req.params.key);
    if (!key.success) {
      throw RouteErrorFactory.validation("invalid feature flag key");
    }
    try {
      return res.json({ data: getFeatureFlag(key.data) });
    } catch (e) {
      if (handleFlagError(res, e)) return;
      return next(e);
    }
  });

  router.patch("/:key", (req, res, next) => {
    const key = flagKeySchema.safeParse(req.params.key);
    if (!key.success) {
      throw RouteErrorFactory.validation("invalid feature flag key");
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw RouteErrorFactory.validation(parsed.error.issues[0]?.message ?? "invalid body");
    }
    try {
      const flag = updateFeatureFlag(key.data, parsed.data);
      logger.info({ reqId: getRequestId(), key: flag.key, actor: req.adminAddress }, "feature_flag_updated");
      return res.json({ data: flag });
    } catch (e) {
      if (handleFlagError(res, e)) return;
      return next(e);
    }
  });

  router.delete("/:key", (req, res, next) => {
    const key = flagKeySchema.safeParse(req.params.key);
    if (!key.success) {
      throw RouteErrorFactory.validation("invalid feature flag key");
    }
    try {
      deleteFeatureFlag(key.data);
      logger.info({ reqId: getRequestId(), key: key.data, actor: req.adminAddress }, "feature_flag_deleted");
      return res.status(204).send();
    } catch (e) {
      if (handleFlagError(res, e)) return;
      return next(e);
    }
  });

  return router;
}

export const adminFeatureFlagsRouter = createAdminFeatureFlagsRouter();
