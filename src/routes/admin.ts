import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { logger } from "../config/logger";
import { RouteErrorFactory } from "../errors";
import { getRequestId } from "../lib/requestContext";
import { getCorrelationId } from "../middleware/correlation";
import { requireAdmin } from "../middleware/requireAdmin";
import { paginate } from "../utils/cursor";

export interface AdminRouteItem {
  id: string;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  path: string;
  summary: string;
}

export interface AdminRouterOptions {
  items?: readonly AdminRouteItem[];
  rateLimitPerMinute?: number;
}

const adminQuerySchema = z.object({
  cursor: z.string().min(1, "cursor must not be empty when provided").optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { message: "limit must be a positive integer" })
    .optional(),
}).strict();

export const defaultAdminRouteItems: readonly AdminRouteItem[] = [
  { id: "GET /api/admin", method: "GET", path: "/api/admin", summary: "List admin endpoints" },
  { id: "GET /api/admin/audit", method: "GET", path: "/api/admin/audit", summary: "List audit log entries" },
  { id: "GET /api/admin/audit/export", method: "GET", path: "/api/admin/audit/export", summary: "Export audit logs" },
  { id: "GET /api/admin/feature-flags", method: "GET", path: "/api/admin/feature-flags", summary: "List feature flags" },
  { id: "POST /api/admin/feature-flags", method: "POST", path: "/api/admin/feature-flags", summary: "Create a feature flag" },
  { id: "GET /api/admin/health/detail", method: "GET", path: "/api/admin/health/detail", summary: "Read runtime health details" },
  { id: "POST /api/admin/markets/disable", method: "POST", path: "/api/admin/markets/disable", summary: "Disable a market" },
  { id: "POST /api/admin/markets/{id}/feature", method: "POST", path: "/api/admin/markets/{id}/feature", summary: "Feature a market" },
  { id: "DELETE /api/admin/markets/{id}/feature", method: "DELETE", path: "/api/admin/markets/{id}/feature", summary: "Remove a featured market" },
  { id: "POST /api/admin/markets/{id}/force-finalize", method: "POST", path: "/api/admin/markets/{id}/force-finalize", summary: "Force finalize a market" },
  { id: "GET /api/admin/plugins", method: "GET", path: "/api/admin/plugins", summary: "List plugins" },
  { id: "POST /api/admin/plugins", method: "POST", path: "/api/admin/plugins", summary: "Create a plugin" },
  { id: "GET /api/admin/rate-limit/inspect/{address}", method: "GET", path: "/api/admin/rate-limit/inspect/{address}", summary: "Inspect rate limit usage" },
  { id: "POST /api/admin/reindex", method: "POST", path: "/api/admin/reindex", summary: "Trigger a reindex run" },
  { id: "GET /api/admin/recon/markets/{id}", method: "GET", path: "/api/admin/recon/markets/{id}", summary: "Read reconciliation details" },
  { id: "GET /api/admin/schema-versions", method: "GET", path: "/api/admin/schema-versions", summary: "List schema versions" },
  { id: "GET /api/admin/schema-versions/latest", method: "GET", path: "/api/admin/schema-versions/latest", summary: "Read the latest schema version" },
  { id: "GET /api/admin/users/{address}", method: "GET", path: "/api/admin/users/{address}", summary: "Read an admin user view" },
  { id: "GET /api/admin/users/{address}/freeze", method: "GET", path: "/api/admin/users/{address}/freeze", summary: "Read freeze status" },
  { id: "POST /api/admin/users/{address}/freeze", method: "POST", path: "/api/admin/users/{address}/freeze", summary: "Freeze a user" },
  { id: "POST /api/admin/users/{address}/impersonate", method: "POST", path: "/api/admin/users/{address}/impersonate", summary: "Create an impersonation token" },
  { id: "GET /api/admin/users/{address}/notes", method: "GET", path: "/api/admin/users/{address}/notes", summary: "List admin notes for a user" },
  { id: "POST /api/admin/users/{address}/notes", method: "POST", path: "/api/admin/users/{address}/notes", summary: "Create an admin note for a user" },
  { id: "GET /api/admin/webhooks/dlq", method: "GET", path: "/api/admin/webhooks/dlq", summary: "List dead-lettered webhooks" },
  { id: "POST /api/admin/webhooks/dlq/{id}/replay", method: "POST", path: "/api/admin/webhooks/dlq/{id}/replay", summary: "Replay a dead-lettered webhook" },
];

function sortItemsDesc(items: readonly AdminRouteItem[]): AdminRouteItem[] {
  return [...items].sort((left, right) => right.id.localeCompare(left.id));
}

export function createAdminRouter(opts: AdminRouterOptions = {}): Router {
  const router = Router();
  const limit = opts.rateLimitPerMinute ?? 60;
  const items = sortItemsDesc(opts.items ?? defaultAdminRouteItems);

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

  router.get("/", (req, res, next) => {
    try {
      const parsed = adminQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw RouteErrorFactory.validation(
          parsed.error.issues[0]?.message ?? "invalid query parameters",
        );
      }

      const requestId = getRequestId();
      const correlationId = getCorrelationId() ?? res.locals.correlationId;

      logger.info(
        {
          event: "admin_index_requested",
          requestId,
          correlationId,
          adminAddress: req.adminAddress,
          cursor: parsed.data.cursor ?? null,
          limit: parsed.data.limit ?? null,
        },
        "admin_index_requested",
      );

      const page = paginate(
        items,
        (item) => ({ sortValue: item.id, id: item.id }),
        parsed.data.cursor,
        parsed.data.limit,
      );

      logger.info(
        {
          event: "admin_index_returned",
          requestId,
          correlationId,
          adminAddress: req.adminAddress,
          count: page.data.length,
          nextCursor: page.nextCursor,
          total: items.length,
        },
        "admin_index_returned",
      );

      res.json({
        items: page.data,
        next_cursor: page.nextCursor,
        total: items.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminRouter = createAdminRouter();
