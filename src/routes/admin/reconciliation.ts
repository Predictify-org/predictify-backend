import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { reconcileMarket } from "../../services/reconciliationService";
import { REQUEST_ID_HEADER } from "../../lib/http";

const paramsSchema = z.object({
  id: z.string().trim().min(1).max(255),
});

function requestIdOf(req: { id?: unknown }): string {
  return typeof req.id === "string" ? req.id : "";
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
      const requestId = requestIdOf({ id: (req as { id?: unknown }).id });

      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            details: parsed.error.issues,
            requestId,
          },
        });
      }

      const result = await reconcileMarket({
        marketId: parsed.data.id,
        adminAddress: req.adminAddress!,
        ip: requestIpOf({ ip: req.ip }),
        correlationId: requestId,
      });

      res.setHeader(REQUEST_ID_HEADER, requestId);
      return res.json({ data: result });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export const adminReconciliationRouter = createAdminReconciliationRouter();
