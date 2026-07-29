import { Router, Request, Response, NextFunction } from "express";
import { getUserPortfolio } from "../../services/userPortfolioService";
import { userPortfolioParamsSchema } from "../../validators/users";

export const userPortfolioRouter = Router();

userPortfolioRouter.get("/:addr/portfolio", async (req: Request, res: Response, next: NextFunction) => {
  const parsed = userPortfolioParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "invalid_address" } });
  }

  try {
    const portfolio = await getUserPortfolio(parsed.data.addr);
    if (!portfolio) {
      return res.status(404).json({ error: { code: "not_found" } });
    }
    return res.json({ data: portfolio });
  } catch (error) {
    return next(error);
  }
});
