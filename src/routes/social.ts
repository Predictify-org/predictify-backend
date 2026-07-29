import {
  Router,
  type Request,
  type RequestHandler,
} from "express";
import { z } from "zod";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { requireAuth } from "../middleware/requireAuth";
import {
  socialRepository,
  type SocialRepository,
} from "../repositories/socialRepository";
import { createAuditLog } from "../services/auditService";
import { RouteErrorFactory } from "../errors";

const stellarAddressSchema = z
  .string()
  .trim()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

interface SocialRouterDependencies {
  repository?: SocialRepository;
  authMiddleware?: RequestHandler;
  auditLogger?: typeof createAuditLog;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }

  return req.socket.remoteAddress ?? "unknown";
}

async function writeSocialAuditLog(
  req: Request,
  auditLogger: typeof createAuditLog,
  action: "social.followed" | "social.unfollowed",
  targetAddress: string,
): Promise<void> {
  await auditLogger({
    action,
    walletAddress: req.user?.stellarAddress,
    ip: getClientIp(req),
    correlationId: getRequestId() ?? req.id?.toString(),
    rateLimitContext: req.rateLimitContext,
  });

  logger.info(
    {
      reqId: getRequestId() ?? req.id,
      actorAddress: req.user?.stellarAddress,
      targetAddress,
      action,
    },
    "social_graph_mutation",
  );
}

export function createSocialRouter({
  repository = socialRepository,
  authMiddleware = requireAuth,
  auditLogger = createAuditLog,
}: SocialRouterDependencies = {}): Router {
  const router = Router();

  router.post(
    "/:addr/follow",
    authMiddleware,
    async (req, res, next) => {
      const parsed = stellarAddressSchema.safeParse(req.params.addr);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("Invalid Stellar address");
      }

      if (!req.user?.stellarAddress) {
        throw RouteErrorFactory.unauthorized("Authentication required");
      }

      try {
        const data = await repository.followUser(
          req.user.stellarAddress,
          parsed.data,
        );
        await writeSocialAuditLog(
          req,
          auditLogger,
          "social.followed",
          parsed.data,
        );
        res.status(200).json({ data });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/:addr/follow",
    authMiddleware,
    async (req, res, next) => {
      const parsed = stellarAddressSchema.safeParse(req.params.addr);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("Invalid Stellar address");
      }

      if (!req.user?.stellarAddress) {
        throw RouteErrorFactory.unauthorized("Authentication required");
      }

      try {
        const data = await repository.unfollowUser(
          req.user.stellarAddress,
          parsed.data,
        );
        await writeSocialAuditLog(
          req,
          auditLogger,
          "social.unfollowed",
          parsed.data,
        );
        res.status(200).json({ data });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const socialRouter = createSocialRouter();
