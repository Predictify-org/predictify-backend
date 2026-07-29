/**
 * @module middleware/correlation
 *
 * Dedicated X-Correlation-Id middleware for Express routes.
 *
 * Responsibility
 * --------------
 * 1. Resolve the correlation ID for the incoming request using a priority chain:
 *      X-Correlation-Id header  →  X-Request-Id header  →  req.id (pinoHttp)  →  new UUID v4
 * 2. Sanitise the client-supplied value (length-clamp + strip unsafe chars) to
 *    prevent log-injection attacks.
 * 3. Persist the resolved ID in the AsyncLocalStorage context carried by
 *    `requestContextStorage` so any downstream code (services, workers) can
 *    retrieve it with `getCorrelationId()` without prop-drilling.
 * 4. Stamp `res.locals.correlationId` so view-layer and downstream middleware
 *    can reference it without touching ALS directly.
 * 5. Echo the resolved ID back to the caller via the `X-Correlation-Id`
 *    response header, enabling end-to-end distributed tracing.
 *
 * Usage
 * -----
 *   import { correlationMiddleware } from "../middleware/correlation";
 *
 *   // Mount once at the top of any router that needs correlation IDs:
 *   router.use(correlationMiddleware);
 *
 *   // Retrieve the ID anywhere in the call stack:
 *   import { getCorrelationId } from "../middleware/correlation";
 *   logger.info({ correlationId: getCorrelationId() }, "doing work");
 *
 * Security notes
 * --------------
 * - Only alphanumeric characters, hyphens, and underscores are accepted from
 *   the client (`/[^A-Za-z0-9\-_]/g` is stripped). This prevents newline
 *   injection and similar log-forging attacks.
 * - The accepted length is capped at MAX_CORRELATION_ID_LEN (128 chars).
 * - When the sanitised value is empty a fresh UUID v4 is generated, so the
 *   middleware always produces a non-empty ID.
 */

import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { requestContextStorage } from "../lib/requestContext";

/** Maximum length accepted for a client-supplied correlation ID. */
export const MAX_CORRELATION_ID_LEN = 128;

/** Response / request header name. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

// ── Module-level ALS getter ──────────────────────────────────────────────────

/**
 * Returns the correlation ID for the currently active async context,
 * or `undefined` when called outside of a request (e.g. start-up code).
 */
export function getCorrelationId(): string | undefined {
  return requestContextStorage.getStore()?.correlationId;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Sanitises a raw correlation-ID string provided by the client.
 *
 * - Strips any characters that are not alphanumeric, hyphen, or underscore.
 * - Truncates to `MAX_CORRELATION_ID_LEN`.
 * - Returns `undefined` when the result would be empty.
 */
export function sanitiseCorrelationId(
  raw: string | undefined,
): string | undefined {
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
export function resolveCorrelationId(req: Request): string {
  return (
    sanitiseCorrelationId(
      req.headers[CORRELATION_ID_HEADER] as string | undefined,
    ) ??
    sanitiseCorrelationId(
      req.headers["x-request-id"] as string | undefined,
    ) ??
    sanitiseCorrelationId(
      String((req as { id?: unknown }).id ?? ""),
    ) ??
    randomUUID()
  );
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Express middleware — resolve, store, and echo X-Correlation-Id.
 *
 * Must be mounted before any handler that needs `getCorrelationId()`.
 * Designed to run *inside* the existing `requestContextStorage.run()` closure
 * already established in `src/index.ts` so that it can extend the store with
 * the `correlationId` field.
 *
 * If the ALS store is not yet initialised (e.g. when this middleware is mounted
 * on an isolated test router without the global ALS wrapper) a new store context
 * is started automatically so the middleware is always self-contained.
 *
 * Always calls `next()` — safe to mount as the first middleware on any router.
 */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId = resolveCorrelationId(req);

  // Make the correlation ID available downstream via res.locals.
  res.locals.correlationId = correlationId;

  // Echo it back in the response so callers can correlate their own traces.
  res.setHeader(CORRELATION_ID_HEADER, correlationId);

  // Extend (or create) the ALS context with the correlationId field.
  const existing = requestContextStorage.getStore();
  if (existing) {
    // Mutate the existing store in-place so requestId / fingerprint are
    // preserved — no need to start a new context.
    existing.correlationId = correlationId;
    next();
  } else {
    // No parent context (e.g. isolated test router) — bootstrap one now.
    requestContextStorage.run(
      { requestId: correlationId, correlationId },
      next,
    );
  }
}

// ── Outbound call helper re-export ──────────────────────────────────────────
export { fetchWithCorrelationId } from "../lib/http";

// ── Auto-propagate on all outbound fetch calls ──────────────────────────────
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const correlationId = getCorrelationId();
  if (!correlationId) {
    return originalFetch(input, init);
  }

  const headers = new Headers(init?.headers);
  if (!headers.has(CORRELATION_ID_HEADER)) {
    headers.set(CORRELATION_ID_HEADER, correlationId);
  }

  return originalFetch(input, { ...init, headers });
};
