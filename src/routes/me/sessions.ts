/**
 * GET /api/me/sessions — list active sessions (#333).
 */
import { Router, type Response, type NextFunction } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db";
import { refreshTokens } from "../../db/schema";
import { requireAuth } from "../../middleware/requireAuth";
import { AuthenticatedRequest } from "../../middleware/auth";
import { logger } from "../../config/logger";

export interface SessionSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export const sessionsRouter = Router();

sessionsRouter.use(requireAuth);

sessionsRouter.get(
  "/",
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
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

      const byFamily = new Map<string, SessionSummary>();
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

      const sessions = Array.from(byFamily.values()).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      );

      logger.info({ userId, count: sessions.length }, "me_sessions_listed");

      return res.json({ data: { sessions } });
    } catch (err) {
      return next(err);
    }
  },
);
