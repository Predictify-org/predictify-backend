import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { reconcileMarket } from "../../services/reconciliationService";
import { CORRELATION_ID_HEADER } from "../../lib/http";
import { getCorrelationId } from "../../middleware/correlation";
import { RouteErrorFactory } from "../../errors";

const paramsSchema = z.object({
  id: z.string().trim().min(1).max(255),
});

function requestIdOf(req: { id?: unknown }): string {
  return getCorrelationId() ?? (typeof req.id === "string" ? req.id : "") ?? "";
}

function requestIpOf(req: { ip?: unknown }): string {
  return typeof req.ip === "string" ? req.ip : "";
}

export function createAdminReconciliationRouter(): Router {
  const router = Router();

  router.use(requireAdmin);

  router.get("/markets/:id", async (req, res, next) => {
    try {
      const parsed = paramsSchema.safeParse(req.params);
      const correlationId = requestIdOf({ id: (req as { id?: unknown }).id });

      if (!parsed.success) {
        throw RouteErrorFactory.validation("Invalid market ID");
      }

      const result = await reconcileMarket({
        marketId: parsed.data.id,
        adminAddress: req.adminAddress!,
        ip: requestIpOf({ ip: req.ip }),
        correlationId,
      });

      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      return res.json({ data: result, correlationId });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export const adminReconciliationRouter = createAdminReconciliationRouter();
