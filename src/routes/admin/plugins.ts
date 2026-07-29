/**
 * Admin plugin CRUD router.
 *
 *   GET    /api/admin/plugins          — list plugins (optional ?enabled=true|false)
 *   POST   /api/admin/plugins          — create a plugin
 *   GET    /api/admin/plugins/:id      — get a single plugin
 *   PATCH  /api/admin/plugins/:id      — partially update a plugin
 *   DELETE /api/admin/plugins/:id      — delete a plugin
 *
 * All routes require a valid admin JWT (role: "admin") in the Authorization
 * header and are rate-limited per admin token.
 */

import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { REQUEST_ID_HEADER } from "../../lib/http";
import { getRequestId } from "../../lib/requestContext";
import type { PluginRepository } from "../../services/pluginService";
import {
  DrizzlePluginRepository,
  PluginNotFoundError,
  PluginNameConflictError,
  listPlugins,
  getPlugin,
  createPlugin,
  updatePlugin,
  deletePlugin,
} from "../../services/pluginService";

// ─── Schemas ────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  enabled: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { message: "limit must be a positive integer" })
    .transform((v) => parseInt(v, 10))
    .refine((n) => n >= 1 && n <= 200, {
      message: "limit must be between 1 and 200",
    })
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/, { message: "offset must be a non-negative integer" })
    .transform((v) => parseInt(v, 10))
    .optional(),
});

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const updateBodySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const paramsSchema = z.object({
  id: z.string().uuid({ message: "id must be a valid UUID" }),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function requestIdOf(req: { id?: unknown }): string {
  return (
    getRequestId() ??
    (typeof req.id === "string" ? req.id : "")
  );
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

// ─── Router factory ─────────────────────────────────────────────────────────

export interface AdminPluginsRouterOptions {
  /** Inject a fake repo in tests. */
  repo?: PluginRepository;
  /** Requests per minute per admin token. Default: 60 */
  rateLimitPerMinute?: number;
}

export function createAdminPluginsRouter(
  opts: AdminPluginsRouterOptions = {},
): Router {
  const router = Router();
  const repo = opts.repo ?? new DrizzlePluginRepository();
  const limit = opts.rateLimitPerMinute ?? 60;

  // ── Rate limiter ──────────────────────────────────────────────────────────
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ??
        req.ip ??
        "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ───────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── GET / ── list plugins ─────────────────────────────────────────────────
  router.get("/", async (req, res, next) => {
    try {
      const requestId = requestIdOf({ id: (req as { id?: unknown }).id });
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              parsed.error.issues[0]?.message ?? "invalid query parameters",
            details: parsed.error.issues,
            requestId,
          },
        });
        return;
      }

      const result = await listPlugins(parsed.data, repo);
      res.setHeader(REQUEST_ID_HEADER, requestId);
      res.json({ data: result.data, total: result.total });
    } catch (e) {
      next(e);
    }
  });

  // ── POST / ── create plugin ───────────────────────────────────────────────
  router.post("/", async (req, res, next) => {
    try {
      const requestId = requestIdOf({ id: (req as { id?: unknown }).id });

      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              parsed.error.issues[0]?.message ?? "invalid request body",
            details: parsed.error.issues,
            requestId,
          },
        });
        return;
      }

      if (!req.adminAddress) {
        res.status(401).json({ error: { code: "unauthorized", requestId } });
        return;
      }

      const plugin = await createPlugin(parsed.data, {
        adminAddress: req.adminAddress,
        ip: extractClientIp(req),
        correlationId: requestId,
      }, repo);

      res.setHeader(REQUEST_ID_HEADER, requestId);
      res.status(201).json({ data: plugin });
    } catch (e) {
      if (e instanceof PluginNameConflictError) {
        const requestId = requestIdOf({ id: (req as { id?: unknown }).id });
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(409).json({
          error: { code: "name_conflict", message: e.message, requestId },
        });
        return;
      }
      next(e);
    }
  });

  // ── GET /:id ── get plugin by ID ─────────────────────────────────────────
  router.get("/:id", async (req, res, next) => {
    try {
      const requestId = requestIdOf({ id: (req as { id?: unknown }).id });
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              parsed.error.issues[0]?.message ?? "invalid id parameter",
            details: parsed.error.issues,
            requestId,
          },
        });
        return;
      }

      const plugin = await getPlugin(parsed.data.id, repo);
      if (!plugin) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(404).json({ error: { code: "not_found", requestId } });
        return;
      }

      res.setHeader(REQUEST_ID_HEADER, requestId);
      res.json({ data: plugin });
    } catch (e) {
      next(e);
    }
  });

  // ── PATCH /:id ── update plugin ──────────────────────────────────────────
  router.patch("/:id", async (req, res, next) => {
    try {
      const requestId = requestIdOf({ id: (req as { id?: unknown }).id });

      const paramsParsed = paramsSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              paramsParsed.error.issues[0]?.message ?? "invalid id parameter",
            details: paramsParsed.error.issues,
            requestId,
          },
        });
        return;
      }

      const bodyParsed = updateBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              bodyParsed.error.issues[0]?.message ?? "invalid request body",
            details: bodyParsed.error.issues,
            requestId,
          },
        });
        return;
      }

      if (Object.keys(bodyParsed.data).length === 0) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message: "at least one field must be provided for update",
            requestId,
          },
        });
        return;
      }

      if (!req.adminAddress) {
        res.status(401).json({ error: { code: "unauthorized", requestId } });
        return;
      }

      const plugin = await updatePlugin(paramsParsed.data.id, bodyParsed.data, {
        adminAddress: req.adminAddress,
        ip: extractClientIp(req),
        correlationId: requestId,
      }, repo);

      res.setHeader(REQUEST_ID_HEADER, requestId);
      res.json({ data: plugin });
    } catch (e) {
      if (e instanceof PluginNotFoundError) {
        const requestId = requestIdOf({ id: (req as { id?: unknown }).id });
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(404).json({ error: { code: "not_found", requestId } });
        return;
      }
      next(e);
    }
  });

  // ── DELETE /:id ── delete plugin ─────────────────────────────────────────
  router.delete("/:id", async (req, res, next) => {
    try {
      const requestId = requestIdOf({ id: (req as { id?: unknown }).id });
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(400).json({
          error: {
            code: "validation_error",
            message:
              parsed.error.issues[0]?.message ?? "invalid id parameter",
            details: parsed.error.issues,
            requestId,
          },
        });
        return;
      }

      if (!req.adminAddress) {
        res.status(401).json({ error: { code: "unauthorized", requestId } });
        return;
      }

      const result = await deletePlugin(parsed.data.id, {
        adminAddress: req.adminAddress,
        ip: extractClientIp(req),
        correlationId: requestId,
      }, repo);

      res.setHeader(REQUEST_ID_HEADER, requestId);
      res.json({ data: result });
    } catch (e) {
      if (e instanceof PluginNotFoundError) {
        const requestId = requestIdOf({ id: (req as { id?: unknown }).id });
        res.setHeader(REQUEST_ID_HEADER, requestId);
        res.status(404).json({ error: { code: "not_found", requestId } });
        return;
      }
      next(e);
    }
  });

  return router;
}

// Default export wired into src/index.ts.
export const adminPluginsRouter = createAdminPluginsRouter();
