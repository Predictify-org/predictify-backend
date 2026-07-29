import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { logger } from "../../config/logger";
import { getCorrelationId } from "../../middleware/correlation";
import {
  featureMarket,
  unfeatureMarket,
  MarketArchivedError,
  MarketNotFoundError,
} from "../../services/marketFeatureService";
import { RouteErrorFactory } from "../../errors";

// Define custom interface for request with user context
interface AuthenticatedAdminRequest extends Request {
  adminAddress?: string;
  user?: {
    stellarAddress: string;
    [key: string]: unknown;
  };
}

function extractClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]!;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

const paramsSchema = z.object({
  id: z.string().trim().min(1).max(255),
});

function requestIdOf(req: { id?: unknown }): string {
  return getCorrelationId() ?? (typeof req.id === "string" ? req.id : "") ?? "";
}

export interface AdminMarketsRouterOptions {
  rateLimitPerMinute?: number;
}

export function createAdminMarketsRouter(
  opts: AdminMarketsRouterOptions = {},
): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  router.use(requireAdmin);

  const handle = async (
    req: AuthenticatedAdminRequest,
    res: Response,
    operation: "feature" | "unfeature",
  ): Promise<void> => {
    const parsed = paramsSchema.safeParse(req.params);
    const requestId = requestIdOf({ id: (req as Record<string, unknown>).id });

    if (!parsed.success) {
      throw RouteErrorFactory.validation("Invalid market ID");
    }

    if (!req.adminAddress) {
      throw RouteErrorFactory.unauthorized("Authentication required");
    }

    const handler = operation === "feature" ? featureMarket : unfeatureMarket;
    try {
      const result = await handler(parsed.data.id, req.adminAddress, {
        ip: extractClientIp(req),
        correlationId: requestId,
      });
      res.status(200).json({ data: result });
    } catch (err) {
      if (err instanceof MarketNotFoundError) {
        throw RouteErrorFactory.notFound("Market not found");
      }
      if (err instanceof MarketArchivedError) {
        throw RouteErrorFactory.badRequest(err.message);
      }
      throw err;
    }
  };

  router.post("/:id/feature", async (req, res, next) => {
    try {
      await handle(req as AuthenticatedAdminRequest, res, "feature");
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/feature", async (req, res, next) => {
    try {
      await handle(req as AuthenticatedAdminRequest, res, "unfeature");
    } catch (err) {
      next(err);
    }
  });

  const disableBodySchema = z
    .object({
      marketId: z.string().min(1, "marketId is required"),
      reason: z.string().min(1, "reason is required").max(500),
    })
    .strict();

  router.post("/disable", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = disableBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: { code: "validation_error", details: parsed.error.issues },
        });
      }

      const { marketId, reason } = parsed.data;
      const adminReq = req as AuthenticatedAdminRequest;
      const adminAddress = adminReq.user?.stellarAddress ?? adminReq.adminAddress ?? "";

      const updated = await disableMarket(marketId, reason, adminAddress);

      logger.info({ marketId, adminAddress }, "admin_market_disabled");
      return res.status(200).json({ data: updated });
    } catch (e) {
      if (e instanceof MarketAlreadyDisabledError) {
        return res.status(409).json({ error: { code: "already_disabled" } });
      }
      if ((e as { status?: number }).status === 404) {
        return res.status(404).json({ error: { code: "not_found" } });
      }
      return next(e);
    }
  });

  return router;
}

export const adminMarketsRouter = createAdminMarketsRouter();
