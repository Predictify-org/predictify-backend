import { Router } from "express";
import { listMarkets, getMarketById } from "../services/marketService";
import { AppError } from "../errors";

export const marketsRouter = Router();

marketsRouter.get("/", async (_req, res, next) => {
  try {
    return res.json({ data: await listMarkets() });
  } catch (e) { return next(e); }
});

marketsRouter.get("/:id", async (req, res, next) => {
  try {
    const market = await getMarketById(req.params.id);
    if (!market) return next(AppError.notFound("Market not found"));
    res.json({ data: market });
  } catch (e) { next(e); }
});
