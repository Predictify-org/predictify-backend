import { Router } from "express";
import { z } from "zod";
import {
  getLeaderboard,
  getLeaderboardWithRefresh,
  getUserLeaderboardEntry,
  leaderboardPeriods,
} from "../services/leaderboardService";

export const leaderboardRouter = Router();

const leaderboardQuerySchema = z.object({
  period: z.enum(leaderboardPeriods).default("daily"),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  refresh: z.coerce.boolean().default(false),
});

// GET /api/leaderboard - Get leaderboard with optional refresh
leaderboardRouter.get("/", async (req, res, next) => {
  try {
    const { period, limit, offset, refresh } = leaderboardQuerySchema.parse(req.query);
    
    const data = refresh 
      ? await getLeaderboardWithRefresh(period, limit, offset)
      : await getLeaderboard(period, limit, offset);
    
    res.json({ 
      data,
      meta: {
        period,
        limit,
        offset,
        count: data.length,
        refresh
      }
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/leaderboard/user/:stellarAddress - Get specific user's leaderboard entry
leaderboardRouter.get("/user/:stellarAddress", async (req, res, next) => {
  try {
    const { period } = leaderboardQuerySchema.pick({ period: true }).parse(req.query);
    const entry = await getUserLeaderboardEntry(req.params.stellarAddress, period);
    if (!entry) {
      return res.status(404).json({ error: { code: "not_found" } });
    }
    return res.json({ data: entry, meta: { period } });
  } catch (e) {
    return next(e);
  }
});
