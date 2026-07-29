import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import {
  getFreezeStatus,
  freezeUser,
  unfreezeUser,
} from "../../../services/userFreezeService";
import { RouteErrorFactory } from "../../../errors";

export interface AdminFreezeRouterOptions {
  rateLimitPerMinute?: number;
}

const stellarAddressSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

const freezeBodySchema = z
  .object({
    reason: z.string().max(280).nullish(),
  })
  .strict()
  .optional();

export function createAdminFreezeRouter(opts: AdminFreezeRouterOptions = {}): Router {
  const router = Router({ mergeParams: true });
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

  router.get("/:address/freeze", (req, res, next) => {
    try {
      const parsed = stellarAddressSchema.safeParse(req.params.address);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("invalid stellar address");
      }
      return res.json({ data: getFreezeStatus(parsed.data) });
    } catch (e) {
      next(e);
    }
  });

  router.post("/:address/freeze", (req, res, next) => {
    try {
      const parsed = stellarAddressSchema.safeParse(req.params.address);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("invalid stellar address");
      }
      const body = freezeBodySchema.safeParse(req.body);
      if (!body.success) {
        throw RouteErrorFactory.validation(body.error.issues[0]?.message ?? "invalid body");
      }

      const record = freezeUser(parsed.data, req.adminAddress!, body.data?.reason ?? null);
      logger.info(
        { reqId: getRequestId(), address: parsed.data, actor: req.adminAddress },
        "user_frozen",
      );
      return res.json({ data: record });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/:address/freeze", (req, res, next) => {
    try {
      const parsed = stellarAddressSchema.safeParse(req.params.address);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("invalid stellar address");
      }

      const record = unfreezeUser(parsed.data, req.adminAddress!);
      logger.info(
        { reqId: getRequestId(), address: parsed.data, actor: req.adminAddress },
        "user_unfrozen",
      );
      return res.json({ data: record });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export const adminFreezeRouter = createAdminFreezeRouter();
