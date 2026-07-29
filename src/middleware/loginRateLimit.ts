import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { extractClientIp, SlidingWindowStore } from "./rateLimitAnon";

export interface LoginRateLimitOptions {
  windowMs: number;
  max: number;
  trustProxy?: boolean;
  store?: SlidingWindowStore;
}

export function createLoginRateLimit(options: LoginRateLimitOptions): RequestHandler {
  const { windowMs, max, trustProxy = false, store = new SlidingWindowStore() } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const clientIp = extractClientIp(req, trustProxy);
    const active = store.getTimestamps(clientIp, now, windowMs);

    if (active.length >= max) {
      const oldestTimestamp = active[0]!;
      const remainingMs = oldestTimestamp + windowMs - now;
      const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));

      logger.warn(
        {
          reqId: getRequestId(),
          clientIp,
          path: req.path,
          method: req.method,
          windowMs,
          max,
          retryAfter,
        },
        "login_rate_limit_exceeded",
      );

      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: {
          code: "rate_limit_exceeded",
          message: "Too many login attempts. Please try again later.",
          retryAfter,
          ...(getRequestId() ? { requestId: getRequestId() } : {}),
        },
      });
      return;
    }

    store.record(clientIp, now, windowMs);
    next();
  };
}

export const loginRateLimitStore = new SlidingWindowStore();

export const loginRateLimit: RequestHandler = createLoginRateLimit({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.LOGIN_RATE_LIMIT_MAX,
  trustProxy: env.TRUST_PROXY,
  store: loginRateLimitStore,
});
