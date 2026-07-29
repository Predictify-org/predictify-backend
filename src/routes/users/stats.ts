import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getUserStats } from "../../services/userStatsService";

export const userStatsRouter = Router();

const stellarAddressSchema = z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

userStatsRouter.get("/:addr/stats", async (req: Request, res: Response, next: NextFunction) => {
  const parsed = stellarAddressSchema.safeParse(req.params.addr);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "invalid_address" } });
  }

  try {
    const stats = await getUserStats(parsed.data);
    if (!stats) {
      return res.status(404).json({ error: { code: "not_found" } });
    }
    return res.json({ data: stats });
  } catch (error) {
    return next(error);
  }
});
