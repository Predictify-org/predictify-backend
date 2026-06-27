import { Router } from "express";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { requireAdmin } from "../../middleware/requireAdmin";
import { seedSampleMarkets } from "../../services/seedService";

export const adminSeedRouter = Router();

adminSeedRouter.post("/", requireAdmin, async (req, res, next) => {
  try {
    if (env.NODE_ENV === "production") {
      res.status(404).json({ error: { code: "not_found" } });
      return;
    }

    const result = await seedSampleMarkets();
    logger.info(
      {
        adminAddress: req.adminAddress,
        inserted: result.inserted,
        requested: result.requested,
        seedKey: result.seedKey,
      },
      "admin_seed_markets_completed",
    );

    res.status(201).json({ data: result });
  } catch (e) {
    next(e);
  }
});
