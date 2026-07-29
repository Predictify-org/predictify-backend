import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { refreshTokens } from "../db/schema";
import { requireAuth } from "../middleware/requireAuth";
import { AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../config/logger";
import { RouteErrorFactory } from "../errors";
import { securityHeaders } from "../middleware/securityHeaders";

const deviceIdParamSchema = z.object({ id: z.string().uuid({ message: "invalid device id" }) });

export const devicesRevokeRouter = Router({ mergeParams: true });

// Apply security headers first — ensures CSP, X-Content-Type-Options, and
// Referrer-Policy are present on every response including 401/403s.
devicesRevokeRouter.use(securityHeaders);
devicesRevokeRouter.use(requireAuth);

devicesRevokeRouter.post(
  "/",
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = deviceIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw parsed.error;
      }

      const userId = req.user!.id;
      const familyId = parsed.data.id;

      const revoked = await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.familyId, familyId),
            isNull(refreshTokens.revokedAt),
          ),
        )
        .returning({ id: refreshTokens.id });

      if (revoked.length === 0) {
        logger.info({ userId, familyId }, "me_device_revoke_noop");
        throw RouteErrorFactory.notFound("Device not found");
      }

      logger.info({ userId, familyId, revoked: revoked.length }, "me_device_revoked");
      return res.status(200).json({ data: { id: familyId, revoked: revoked.length } });
    } catch (err) {
      return next(err);
    }
  },
);
