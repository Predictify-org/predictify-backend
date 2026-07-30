import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { logger } from "../config/logger";

export interface CorsAllowlistOptions {
  allowedOrigins: string[];
  allowCredentials?: boolean;
  maxAgeSeconds?: number;
}

function parseOrigin(req: Request): string | undefined {
  const origin = req.headers["origin"];
  if (!origin || typeof origin !== "string") return undefined;
  return origin.trim();
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(origin);
}

function denyOrigin(res: Response, message: string): void {
  const correlationId =
    (res.locals.correlationId as string) ?? "unknown";
  res.status(403).json({
    error: {
      code: "forbidden",
      message,
      correlationId,
    },
  });
}

/**
 * Creates an Express middleware that enforces a CORS allowlist.
 *
 * - Requests without a matching `Origin` header are denied with 403.
 * - OPTIONS preflight requests from allowed origins are acknowledged with 204
 *   and cached via `Access-Control-Max-Age`.
 * - When the allowlist is empty **all** origins are denied (deny by default).
 */
export function createCorsAllowlistMiddleware(
  options: CorsAllowlistOptions,
) {
  const { allowedOrigins, allowCredentials = true, maxAgeSeconds = 600 } = options;

  if (!allowedOrigins.length) {
    logger.warn("CORS allowlist is empty — all origins will be denied");
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = parseOrigin(req);

    if (!origin) {
      logger.warn(
        { path: req.path, method: req.method },
        "CORS: missing Origin header",
      );
      denyOrigin(res, "Origin header is required");
      return;
    }

    if (!isOriginAllowed(origin, allowedOrigins)) {
      logger.warn(
        { origin, path: req.path, method: req.method },
        "CORS: origin not allowed",
      );
      denyOrigin(res, `Origin "${origin}" is not allowed`);
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    if (allowCredentials) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-request-id",
      );
      res.setHeader("Access-Control-Max-Age", String(maxAgeSeconds));
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * Pre-configured CORS middleware for the webhooks endpoint.
 * Reads allowed origins from the `WEBHOOK_CORS_ALLOWED_ORIGINS` env variable.
 */
let webhookCorsMiddleware: ReturnType<typeof createCorsAllowlistMiddleware> | null = null;

export function webhookCors(): ReturnType<typeof createCorsAllowlistMiddleware> {
  if (!webhookCorsMiddleware) {
    const raw = env.WEBHOOK_CORS_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    webhookCorsMiddleware = createCorsAllowlistMiddleware({
      allowedOrigins,
      allowCredentials: true,
      maxAgeSeconds: 600,
    });
  }
  return webhookCorsMiddleware;
}

/**
 * Pre-configured CORS middleware for the markets endpoint.
 * Reads allowed origins from the `MARKETS_CORS_ALLOWED_ORIGINS` env variable.
 * When the allowlist is empty, all cross-origin requests to /api/markets are denied.
 */
let marketsCorsMiddleware: ReturnType<typeof createCorsAllowlistMiddleware> | null = null;

export function marketsCors(): ReturnType<typeof createCorsAllowlistMiddleware> {
  if (!marketsCorsMiddleware) {
    const raw = env.MARKETS_CORS_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    marketsCorsMiddleware = createCorsAllowlistMiddleware({
      allowedOrigins,
      allowCredentials: true,
      maxAgeSeconds: 600,
    });
  }
  return marketsCorsMiddleware;
}

/**
 * Pre-configured CORS middleware for the notifications endpoint.
 * Reads allowed origins from the `NOTIFICATIONS_CORS_ALLOWED_ORIGINS` env variable.
 * When the allowlist is empty, all cross-origin requests to /api/notifications are denied.
 */
let notificationsCorsMiddleware: ReturnType<typeof createCorsAllowlistMiddleware> | null = null;

export function notificationsCors(): ReturnType<typeof createCorsAllowlistMiddleware> {
  if (!notificationsCorsMiddleware) {
    const raw = env.NOTIFICATIONS_CORS_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    notificationsCorsMiddleware = createCorsAllowlistMiddleware({
      allowedOrigins,
      allowCredentials: true,
      maxAgeSeconds: 600,
    });
  }
  return notificationsCorsMiddleware;
}

/**
 * Pre-configured CORS middleware for the stats endpoint.
 * Reads allowed origins from the `STATS_CORS_ALLOWED_ORIGINS` env variable.
 * When the allowlist is empty, all cross-origin requests to /api/stats are denied.
 */
let statsCorsMiddleware: ReturnType<typeof createCorsAllowlistMiddleware> | null = null;

export function statsCors(): ReturnType<typeof createCorsAllowlistMiddleware> {
  if (!statsCorsMiddleware) {
    const raw = env.STATS_CORS_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    statsCorsMiddleware = createCorsAllowlistMiddleware({
      allowedOrigins,
      allowCredentials: true,
      maxAgeSeconds: 600,
    });
  }
  return statsCorsMiddleware;
}

export const enforceCors = marketsCors();

/**
 * Pre-configured CORS middleware for the audit endpoint.
 * Reads allowed origins from the `AUDIT_CORS_ALLOWED_ORIGINS` env variable.
 * When the allowlist is empty, all cross-origin requests to /api/audit are denied.
 */
let auditCorsMiddleware: ReturnType<typeof createCorsAllowlistMiddleware> | null = null;

export function auditCors(): ReturnType<typeof createCorsAllowlistMiddleware> {
  if (!auditCorsMiddleware) {
    const raw = env.AUDIT_CORS_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    auditCorsMiddleware = createCorsAllowlistMiddleware({
      allowedOrigins,
      allowCredentials: true,
      maxAgeSeconds: 600,
    });
  }
  return auditCorsMiddleware;
}
