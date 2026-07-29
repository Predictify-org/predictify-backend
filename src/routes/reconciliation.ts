import { Router } from "express";
import rateLimit from "express-rate-limit";
import { performReconciliation, getReconciliationReport, listReconciliationReports } from "../services/reconciliationService";
import { RouteErrorFactory } from "../errors";

export const reconciliationRouter = Router();

const reconciliationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  message: { error: { code: "rate_limit_exceeded", message: "Reconciliation can only be triggered once per hour" } },
  standardHeaders: true,
  legacyHeaders: false,
});

reconciliationRouter.post("/", reconciliationRateLimiter, async (_req, res, next) => {
  try {
    const result = await performReconciliation();
    res.json({ data: result });
  } catch (e) {
    next(e);
  }
});

reconciliationRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const reports = await listReconciliationReports(limit, offset);
    res.json({ data: reports, meta: { limit, offset } });
  } catch (e) {
    next(e);
  }
});

reconciliationRouter.get("/:reportId", async (req, res, next) => {
  try {
    const report = await getReconciliationReport(req.params.reportId);
    if (!report) {
      throw RouteErrorFactory.notFound("Reconciliation report not found");
    }
    return res.json({ data: report });
  } catch (e) {
    return next(e);
  }
});
