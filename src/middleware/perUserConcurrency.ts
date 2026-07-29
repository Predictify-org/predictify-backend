/**
 * @module middleware/perUserConcurrency
 *
 * Per-user concurrent request limiting middleware.
 *
 * Motivation
 * ----------
 * Rate limiting (sliding-window / token-bucket) restricts *throughput* over a
 * time window but cannot prevent a single user from holding many connections
 * open simultaneously (e.g. long-polling, slow uploads, streaming responses).
 * This middleware caps the number of *in-flight* requests per identity so that
 * a misbehaving or abusive client cannot monopolise the server's thread pool or
 * database connection pool.
 *
 * How it works
 * ------------
 * 1. On every incoming request, resolve an identity key (authenticated user ID
 *    or, as a fallback, the client IP address).
 * 2. Atomically increment an in-flight counter stored in a module-level
 *    `Map<string, number>`.
 * 3. If the counter exceeds `MAX_CONCURRENT_REQUESTS_PER_USER`, respond
 *    immediately with **HTTP 429** and a `Retry-After` header. The counter is
 *    decremented immediately in this path so it stays accurate.
 * 4. Otherwise, register a `res.on("finish")` listener that decrements the
 *    counter once the response is fully flushed, regardless of whether the
 *    request succeeded or errored.
 *
 * Configuration
 * -------------
 * The per-user limit is read from the `MAX_CONCURRENT_REQUESTS_PER_USER`
 * environment variable (zod-validated in `src/config/env-schema.ts`).
 * Default: **10**.
 *
 * Identity resolution order
 * -------------------------
 * 1. `req.user.id`           — populated by `requireAuth` / `optionalAuth`
 * 2. `req.user.stellarAddress` — fallback populated by the same middlewares
 * 3. `X-Forwarded-For` / `req.socket.remoteAddress` — anonymous callers
 *
 * Error envelope
 * --------------
 * ```json
 * {
 *   "error": {
 *     "code": "concurrency_limit_exceeded",
 *     "message": "Too many concurrent requests",
 *     "retryAfter": 1
 *   }
 * }
 * ```
 *
 * Security notes
 * --------------
 * - Decrement is guaranteed via `res.on("finish")` so a client hanging the
 *   connection cannot inflate the counter indefinitely — the counter is
 *   decremented when the socket closes even if the response is never flushed.
 *   We additionally register `res.on("close")` as a safety-net for
 *   prematurely-closed connections.
 * - The counter Map is in-process only. In a multi-process deployment each
 *   process maintains its own counter, effectively multiplying the limit by
 *   the number of processes. For single-process deployments (the common case)
 *   this is an exact limit. Document this if deploying behind a process
 *   cluster.
 *
 * Usage
 * -----
 * ```ts
 * import { perUserConcurrency } from "../middleware/perUserConcurrency";
 *
 * // Global: applied to all /api routes
 * app.use("/api", perUserConcurrency);
 *
 * // Or create a custom instance for a specific route group
 * import { createPerUserConcurrencyMiddleware } from "../middleware/perUserConcurrency";
 * app.use("/api/predictions", createPerUserConcurrencyMiddleware({ limit: 5 }));
 * ```
 */

import { randomUUID } from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolves the first hop IP from `X-Forwarded-For` or falls back to the
 * direct socket address.  Mirrors the implementation in rateLimit.ts so
 * behaviour is consistent across all limiting middleware.
 */
function getClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim().length > 0) {
    const firstHop = xff.split(",")[0]?.trim();
    if (firstHop && firstHop.length > 0) {
      return firstHop;
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Returns a stable identity key for the request:
 * - `user:<id>` for authenticated requests (preferred: uses DB user ID)
 * - `ip:<address>` for anonymous / unauthenticated requests
 */
function resolveKey(req: Request): string {
  const user = (req as Request & { user?: { id?: string; stellarAddress?: string } }).user;
  const identity = user?.id ?? user?.stellarAddress;
  if (typeof identity === "string" && identity.trim().length > 0) {
    return `user:${identity.trim()}`;
  }
  return `ip:${getClientIp(req)}`;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface PerUserConcurrencyOptions {
  /**
   * Maximum number of in-flight requests allowed for a single identity at
   * any point in time.  Defaults to `env.MAX_CONCURRENT_REQUESTS_PER_USER`.
   */
  limit?: number;

  /**
   * Override the default key-resolver function.  The function receives the
   * Express `Request` and must return a non-empty string that uniquely
   * identifies the caller.
   */
  keyGenerator?: (req: Request) => string;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a new per-user concurrency-limiting middleware with its own
 * isolated counter Map.  Multiple instances (e.g. per-route) do NOT share
 * state unless you reuse the same returned middleware reference.
 *
 * @param options - Optional configuration overrides.
 * @returns An Express `RequestHandler`.
 */
export function createPerUserConcurrencyMiddleware(
  options: PerUserConcurrencyOptions = {},
): RequestHandler {
  // Resolve limit eagerly so env is read once at creation time, not per request.
  const limit = Math.max(1, Math.floor(options.limit ?? env.MAX_CONCURRENT_REQUESTS_PER_USER));
  const keyGenerator = options.keyGenerator ?? resolveKey;

  /** In-flight counter per identity key. */
  const counters = new Map<string, number>();

  return function perUserConcurrencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Resolve correlation ID for structured logging (mirrors pattern in errorHandler.ts).
    const correlationId: string =
      (res.locals.correlationId as string | undefined) ??
      (req.headers["x-correlation-id"] as string | undefined) ??
      randomUUID();

    const key = keyGenerator(req);

    // Atomically read-and-increment.
    const current = (counters.get(key) ?? 0) + 1;
    counters.set(key, current);

    if (current > limit) {
      // Limit exceeded — decrement immediately (this request was rejected).
      counters.set(key, current - 1);

      logger.warn(
        {
          correlationId,
          key,
          current: current - 1, // actual in-flight count after rejection
          limit,
          path: req.path,
          method: req.method,
        },
        "concurrency_limit_exceeded",
      );

      // Suggest the caller retry after 1 second (we have no idea when a slot
      // will actually free up, but 1 is the minimum RFC-compliant value).
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        error: {
          code: "concurrency_limit_exceeded",
          message: "Too many concurrent requests",
          retryAfter: 1,
        },
      });
      return;
    }

    // Request admitted — decrement when the response finishes (or closes early).
    let decremented = false;
    const decrement = (): void => {
      if (decremented) return;
      decremented = true;
      const after = Math.max(0, (counters.get(key) ?? 1) - 1);
      if (after === 0) {
        counters.delete(key);
      } else {
        counters.set(key, after);
      }
    };

    res.on("finish", decrement);
    // Safety-net: if the client disconnects before the response is flushed,
    // "close" fires without "finish".  Decrement in both cases.
    res.on("close", decrement);

    next();
  };
}

// ── Default singleton instance ────────────────────────────────────────────────

/**
 * Pre-configured per-user concurrency middleware using the value of
 * `MAX_CONCURRENT_REQUESTS_PER_USER` from the environment (default: 10).
 *
 * Mount this on the `/api` prefix (after body parsing, before route handlers)
 * in `src/index.ts`.
 */
export const perUserConcurrency: RequestHandler =
  createPerUserConcurrencyMiddleware();
