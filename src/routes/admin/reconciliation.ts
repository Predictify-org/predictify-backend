import { Router } from "express";
import { z } from "zod";
import { ADMIN_SCOPES, requireScopedAdmin } from "../../middleware/authorizationScopes";
import {
  reconcileMarket,
  getReconciliationReport,
  listReconciliationReports,
} from "../../services/reconciliationService";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from "../../lib/http";
import { getCorrelationId } from "../../middleware/correlation";
import { RouteErrorFactory } from "../../errors";

const paramsSchema = z.object({
  id: z.string().trim().min(1).max(255),
});

const reportParamsSchema = z.object({
  id: z.string().trim().min(1).max(255),
});

const listReportsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { message: "limit must be a positive integer" })
    .transform((val) => parseInt(val, 10))
    .optional(),
  since: z
    .string()
    .datetime({ message: "since must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
  until: z
    .string()
    .datetime({ message: "until must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
});

function requestIdOf(req: { id?: unknown }): string {
  return getCorrelationId() ?? (typeof req.id === "string" ? req.id : "") ?? "";
}

function requestIpOf(req: { ip?: unknown }): string {
  return typeof req.ip === "string" ? req.ip : "";
}

export function createAdminReconciliationRouter(): Router {
  const router = Router();

  router.use(requireScopedAdmin(ADMIN_SCOPES.REPORT_READ));

  router.get("/markets/:id", async (req, res, next) => {
    const correlationId = requestIdOf({ id: (req as { id?: unknown }).id });
    try {
      const parsed = paramsSchema.safeParse(req.params);

      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            details: parsed.error.issues,
            requestId: correlationId,
          },
        });
      }

      const result = await reconcileMarket({
        marketId: parsed.data.id,
        adminAddress: req.adminAddress!,
        ip: requestIpOf({ ip: req.ip }),
        correlationId,
      });

      res.setHeader(REQUEST_ID_HEADER, correlationId);
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      return res.json({ data: result, correlationId });
    } catch (error: any) {
      if (error?.status === 404 || error?.code === "not_found") {
        return res.status(404).json({
          error: {
            code: "not_found",
            requestId: correlationId,
          },
        });
      }
      return next(error);
    }
  });

  router.get("/reports", async (req, res, next) => {
    try {
      const parsed = listReportsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw RouteErrorFactory.validation(
          parsed.error.issues[0]?.message ?? "Invalid query parameters",
        );
      }

      const limit = parsed.data.limit ?? 20;
      const result = await listReconciliationReports({
        limit,
        cursor: parsed.data.cursor,
        since: parsed.data.since,
        until: parsed.data.until,
      });

      return res.json({
        data: result.reports,
        meta: {
          nextCursor: result.nextCursor,
          limit,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/reports/:id", async (req, res, next) => {
    try {
      const parsed = reportParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("Invalid report ID");
      }

      const report = await getReconciliationReport(parsed.data.id);
      if (!report) {
        throw RouteErrorFactory.notFound("Reconciliation report not found");
      }

      return res.json({ data: report });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export const adminReconciliationRouter = createAdminReconciliationRouter();
