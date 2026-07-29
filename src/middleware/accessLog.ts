/**
 * @module middleware/accessLog
 *
 * Structured access-log middleware for Express routes.
 *
 * Responsibility
 * --------------
 * 1. Resolve the correlation ID for the incoming request using a priority chain:
 *      X-Correlation-Id header  →  X-Request-Id header  →  req.id  →  new UUID
 * 2. Persist the resolved ID on `res.locals.correlationId` so every downstream
 *    handler can reference it without touching AsyncLocalStorage directly.
 * 3. Echo the correlation ID back to the caller via the `X-Correlation-Id`
 *    response header, enabling end-to-end request tracing.
 * 4. Emit a single structured log line on `res.finish` (i.e. after the response
 *    headers and body have been flushed) containing:
 *      - correlationId  : the resolved ID
 *      - method         : HTTP verb
 *      - path           : req.path (path only, no query string — avoids PII in logs)
 *      - statusCode     : HTTP status of the response
 *      - durationMs     : wall-clock time from middleware entry to flush
 *      - ip             : first non-empty value of X-Forwarded-For or req.ip
 *
 * The log name is selected by route prefix so consumers can filter access logs
 * more easily: `/api/users` => `users_access_log`, `/api/auth` =>
 * `auth_access_log`, `/api/predictions` => `predictions_access_log`,
 * `/api/markets` => `markets_access_log`, `/api/tags` =>
 * `tags_access_log`, `/api/feature-flags` => `feature_flags_access_log`,
 * `/api/referrals` => `referrals_access_log`, and `/api/admin` =>
 * `admin_access_log`.
 *
 * Usage
 * -----
 *   import { accessLog } from "../middleware/accessLog";
 *   router.use(accessLog);               // mount once at the top of the router
 *
 * Security notes
 * --------------
 * - Only `req.path` is logged, not `req.url`, so query-string values (which
 *   may contain tokens or PII) never appear in the log stream.
 * - The correlation ID accepted from the client is length-clamped to 128 chars
 *   and stripped to safe alphanumeric / hyphen / underscore characters before
 *   being trusted, preventing log-injection attacks.
 */

import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../config/logger";

/** Maximum length accepted for a client-supplied correlation ID. */
const MAX_CORRELATION_ID_LEN = 128;

/**
 * Sanitises a raw correlation-ID string provided by the client.
 * Strips any characters that are not alphanumeric, hyphen, or underscore and
 * truncates to `MAX_CORRELATION_ID_LEN`.  Returns `undefined` when the result
 * would be empty (so the caller can fall through to the next source).
 */
function sanitiseCorrelationId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .slice(0, MAX_CORRELATION_ID_LEN)
    .replace(/[^A-Za-z0-9\-_]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Resolves the correlation ID for a request using the following priority chain:
 *   1. `X-Correlation-Id` header (client-supplied, sanitised)
 *   2. `X-Request-Id` header (often set by upstream proxies / API gateways)
 *   3. `req.id` (assigned by pino-http earlier in the middleware stack)
 *   4. Freshly generated UUID v4 (guaranteed fallback)
 */
function resolveCorrelationId(req: Request): string {
  return (
    sanitiseCorrelationId(req.headers["x-correlation-id"] as string | undefined) ??
    sanitiseCorrelationId(req.headers["x-request-id"] as string | undefined) ??
    sanitiseCorrelationId(String((req as { id?: unknown }).id ?? "")) ??
    randomUUID()
  );
}

/**
 * Extracts the client IP address.  Prefers the first entry of `X-Forwarded-For`
 * (set by trusted proxies) and falls back to `req.ip` which Express resolves
 * from the socket when `trust proxy` is not set.
 */
function resolveIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(",")[0]
      .trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

/**
 * Express middleware — structured access logger with correlation IDs.
 *
 * Stamps `res.locals.correlationId` and hooks `res.on("finish")` to emit
 * a `users_access_log`, `auth_access_log`, `predictions_access_log`,
 * `markets_access_log`, `tags_access_log`, `referrals_access_log`, or
 * `admin_access_log` log entry once the response
 * has been flushed.
 * Always calls `next()` so it is safe to mount as the first middleware on
 * any router without affecting the handler chain.
 */
export function accessLog(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req);
  const startMs = Date.now();
  const ip = resolveIp(req);

  // Make the correlation ID available to every downstream handler.
  res.locals.correlationId = correlationId;

  // Echo the correlation ID back to the caller so they can correlate
  // their own logs with server-side traces.
  res.setHeader("X-Correlation-Id", correlationId);

  // Emit the access-log entry after the response has been flushed.
  // Using "finish" (not "close") ensures the statusCode is already set.
  res.on("finish", () => {
    let logName = "access_log";
    if (req.originalUrl.startsWith("/api/users")) {
      logName = "users_access_log";
    } else if (req.originalUrl.startsWith("/api/auth")) {
      logName = "auth_access_log";
    } else if (req.originalUrl.startsWith("/api/predictions")) {
      logName = "predictions_access_log";
    } else if (req.originalUrl.startsWith("/api/markets")) {
      logName = "markets_access_log";
    } else if (req.originalUrl.startsWith("/api/feature-flags")) {
      logName = "feature_flags_access_log";
    } else if (req.originalUrl.startsWith("/api/tags")) {
      logName = "tags_access_log";
    } else if (req.originalUrl.startsWith("/api/referrals")) {
      logName = "referrals_access_log";
    } else if (req.originalUrl.startsWith("/api/admin")) {
      logName = "admin_access_log";
    }

    const durationMs = Date.now() - startMs;
    const contentLength = res.getHeader("Content-Length") as string | undefined;
    const size = contentLength ? parseInt(contentLength, 10) : 0;
    // Actor resolution priority:
    //   1. req.adminAddress (set by requireAdmin middleware for admin routes)
    //   2. req.user.id (set by requireAuth middleware for user-facing routes)
    //   3. "anonymous" fallback
    const adminAddress = (req as Request & { adminAddress?: string }).adminAddress;
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    const actor = adminAddress ?? userId ?? "anonymous";

    logger.info(
      {
        "req-id": correlationId, // Alias for /api/tags requirement
        correlationId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        status: res.statusCode, // Alias for /api/tags requirement
        durationMs,
        latency: durationMs, // Alias for /api/tags requirement
        ip,
        size,
        actor,
      },
      logName,
    );
  });

  next();
}
