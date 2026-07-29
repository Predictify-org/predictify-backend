import { Router } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { refreshTokens } from "../db/schema";
import { requireAuth } from "../middleware/requireAuth";
import { AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../config/logger";
import { securityHeaders } from "../middleware/securityHeaders";

export interface DeviceSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export const devicesRouter = Router();

// Apply security headers first — ensures CSP, X-Content-Type-Options, and
// Referrer-Policy are present on every response including 401/403s.
devicesRouter.use(securityHeaders);
devicesRouter.use(requireAuth);

devicesRouter.get(
  "/",
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = listDevicesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw parsed.error;
      }

      const userId = req.user!.id;

      const rows = await db
        .select({
          familyId: refreshTokens.familyId,
          createdAt: refreshTokens.createdAt,
          expiresAt: refreshTokens.expiresAt,
        })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        );

      const byFamily = new Map<string, DeviceSummary>();
      for (const row of rows) {
        const existing = byFamily.get(row.familyId);
        if (!existing || row.createdAt > new Date(existing.createdAt)) {
          byFamily.set(row.familyId, {
            id: row.familyId,
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
          });
        }
      }

      const devices = Array.from(byFamily.values()).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      );

      logger.info({ userId, count: devices.length }, "me_devices_listed");

      return res.json({ data: { devices } });
    } catch (err) {
      return next(err);
    }
  },
);
