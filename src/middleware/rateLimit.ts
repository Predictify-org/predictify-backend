/* eslint-disable @typescript-eslint/no-namespace */
/**
 * @module rateLimit
 *
 * Provides configurable Express rate-limit middleware built on
 * `express-rate-limit`. Two variants are exposed:
 *
 *   - `createRateLimiter`        — generic, defaults to IP-keyed (global use)
 *   - `createUserRateLimiter`    — per-user keyed, falls back to IP when anonymous
 *
 * Pre-configured instances (e.g. `webhooksRateLimiter`) are also exported
 * for routes that consume the rate-limit env vars.
 *
 * Every request — whether allowed or blocked — has its rate-limit context
 * attached to `req.rateLimitContext` for downstream use (audit, status pages).
 *
 * When a request is blocked (429), an audit log entry is created via
 * `auditService` before the error response is sent.
 *
 * Error responses follow the project envelope: `{ error: { code, ... } }`
 */

import rateLimit, {
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  createAuditLog,
  type RateLimitContext,
} from "../services/auditService";
import { env } from "../config/env";
import { logger } from "../config/logger";

declare global {
  namespace Express {
    interface Request {
      rateLimitContext?: RateLimitContext;
      correlationId?: string;
    }
  }
}

type AuthenticatedRequest = Request & {
  user?: {
    sub?: string;
    address?: string;
    id?: string;
  };
};

type TokenBucketState = {
  tokens: number;
  lastRefillAt: number;
};

export interface TokenBucketRateLimitOptions {
  capacity?: number;
  refillWindowMs?: number;
  keyGenerator?: (req: Request) => string;
}

function getClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim().length > 0) {
    const firstHop = xff.split(",")[0]?.trim();
    if (firstHop?.length > 0) {
      return firstHop;
    }
  }

  return req.socket?.remoteAddress ?? "unknown";
}

function getResetAt(res: Response, windowMs: number): string {
  const resetHeader = res.getHeader("RateLimit-Reset");
  if (resetHeader !== undefined) {
    const resetSeconds = Number(resetHeader);
    if (Number.isFinite(resetSeconds)) {
      return new Date(resetSeconds * 1000).toISOString();
    }
  }

  return new Date(Date.now() + windowMs).toISOString();
}

function getRetryAfter(res: Response, windowMs: number): number {
  const retryAfter = Number(res.getHeader("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter);
  }

  const resetHeader = Number(res.getHeader("RateLimit-Reset"));
  if (Number.isFinite(resetHeader)) {
    return Math.max(1, Math.ceil(resetHeader - Date.now() / 1000));
  }

  return Math.max(1, Math.ceil(windowMs / 1000));
}

function attachContext(
  req: Request,
  res: Response,
  blocked: boolean,
  limit: number,
  windowMs: number,
): RateLimitContext {
  const remainingHeader = Number(res.getHeader("RateLimit-Remaining"));
  const remaining = Number.isFinite(remainingHeader)
    ? Math.max(0, remainingHeader)
    : blocked
      ? 0
      : limit;

  const context: RateLimitContext = {
    limit,
    remaining,
    resetAt: getResetAt(res, windowMs),
    blocked,
  };

  req.rateLimitContext = context;
  return context;
}

function attachTokenBucketContext(
  req: Request,
  remaining: number,
  capacity: number,
  resetAt: string,
  blocked: boolean,
): RateLimitContext {
  const context: RateLimitContext = {
    limit: capacity,
    remaining: Math.max(0, remaining),
    resetAt,
    blocked,
  };

  req.rateLimitContext = context;
  return context;
}

function getAuthenticatedUserKey(req: Request): string | undefined {
  const authenticatedRequest = req as AuthenticatedRequest & { adminAddress?: string };
  const identity =
    authenticatedRequest.adminAddress ??
    authenticatedRequest.user?.stellarAddress ??
    authenticatedRequest.user?.address ??
    authenticatedRequest.user?.sub ??
    authenticatedRequest.user?.id;

  if (typeof identity !== "string" || identity.trim().length === 0) {
    return undefined;
  }

  return `user:${identity.trim()}`;
}

export function getUserRateKey(req: Request): string {
  return getAuthenticatedUserKey(req) ?? `ip:${getClientIp(req)}`;
}

function getWalletAddress(req: Request): string | null {
  const authenticatedRequest = req as AuthenticatedRequest & { adminAddress?: string };
  return (
    authenticatedRequest.adminAddress ??
    authenticatedRequest.user?.stellarAddress ??
    authenticatedRequest.user?.address ??
    authenticatedRequest.user?.sub ??
    authenticatedRequest.user?.id ??
    null
  );
}

export function createRateLimiter(
  options: Partial<Options> = {},
): RateLimitRequestHandler {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const configuredLimit = options.limit;
  const limit = typeof configuredLimit === "number" ? configuredLimit : 100;

  const limiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipFailedRequests: false,
    ...options,
    keyGenerator: options.keyGenerator ?? ((req: Request) => getClientIp(req)),
    handler: (req: Request, res: Response) => {
      const correlationId = (req.correlationId ??= uuidv4());
      const context = attachContext(req, res, true, limit, windowMs);
      const retryAfter = getRetryAfter(res, windowMs);

      res.setHeader("Retry-After", String(retryAfter));
      const walletAddress = getWalletAddress(req) ?? undefined;
      logger.warn(
        {
          ip: getClientIp(req),
          correlationId,
          walletAddress,
          rateLimitContext: context,
        },
        "rate_limit_blocked",
      );
      void createAuditLog({
        action: "rate_limit.blocked",
        walletAddress,
        ip: getClientIp(req),
        correlationId,
        rateLimitContext: context,
      }).catch(() => undefined);

      res.status(429).json({
        error: {
          code: "rate_limit_exceeded",
          message: "Too many requests",
          retryAfter,
          resetAt: context.resetAt,
        },
      });
    },
  });

  return ((req: Request, res: Response, next: NextFunction) => {
    req.correlationId ??= uuidv4();
    limiter(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }

      attachContext(req, res, false, limit, windowMs);
      next();
    });
  }) as RateLimitRequestHandler;
}

export function createPerUserTokenBucketLimiter(
  options: TokenBucketRateLimitOptions = {},
): RateLimitRequestHandler {
  const capacity = Math.max(1, Math.floor(options.capacity ?? 60));
  const refillWindowMs = Math.max(
    1,
    Math.floor(options.refillWindowMs ?? 60 * 1000),
  );
  const refillRatePerMs = capacity / refillWindowMs;
  const buckets = new Map<string, TokenBucketState>();

  return ((req: Request, res: Response, next: NextFunction) => {
    req.correlationId ??= uuidv4();

    const overrideKey = options.keyGenerator?.(req);
    const key =
      typeof overrideKey === "string" && overrideKey.trim().length > 0
        ? overrideKey
        : getUserRateKey(req);

    const now = Date.now();
    const bucket = buckets.get(key) ?? {
      tokens: capacity,
      lastRefillAt: now,
    };

    if (bucket.lastRefillAt < now) {
      const elapsedMs = now - bucket.lastRefillAt;
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + elapsedMs * refillRatePerMs,
      );
      bucket.lastRefillAt = now;
    }

    if (bucket.tokens < 1) {
      const msUntilNextToken = Math.max(
        1,
        Math.ceil((1 - bucket.tokens) / refillRatePerMs),
      );
      const retryAfter = Math.max(1, Math.ceil(msUntilNextToken / 1000));
      const resetAt = new Date(now + msUntilNextToken).toISOString();

      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("RateLimit-Limit", String(capacity));
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader(
        "RateLimit-Reset",
        String(Math.ceil((now + msUntilNextToken) / 1000)),
      );

      const context = attachTokenBucketContext(req, 0, capacity, resetAt, true);
      const walletAddress = getWalletAddress(req) ?? undefined;
      logger.warn(
        {
          ip: getClientIp(req),
          correlationId: req.correlationId,
          walletAddress,
          rateLimitContext: context,
        },
        "rate_limit_blocked",
      );
      void createAuditLog({
        action: "rate_limit.blocked",
        walletAddress,
        ip: getClientIp(req),
        correlationId: req.correlationId,
        rateLimitContext: context,
      }).catch(() => undefined);

      res.status(429).json({
        error: {
          code: "rate_limit_exceeded",
          message: "Too many requests",
          retryAfter,
          resetAt: context.resetAt,
        },
      });
      return;
    }

    bucket.tokens = Math.max(0, bucket.tokens - 1);
    buckets.set(key, bucket);

    const remaining = Math.floor(bucket.tokens);
    const msUntilNextToken = Math.max(
      1,
      Math.ceil((1 - bucket.tokens) / refillRatePerMs),
    );
    const resetAt = new Date(now + msUntilNextToken).toISOString();

    res.setHeader("RateLimit-Limit", String(capacity));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader(
      "RateLimit-Reset",
      String(Math.ceil((now + msUntilNextToken) / 1000)),
    );

    attachTokenBucketContext(req, remaining, capacity, resetAt, false);
    next();
  }) as RateLimitRequestHandler;
}

export function createPerUserRateLimiter(
  options: Partial<Options> = {},
): RateLimitRequestHandler {
  return createRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    ...options,
  });
}

export function createUserRateLimiter(options: Partial<Options> = {}): RateLimitRequestHandler {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    keyGenerator: (req) => {
      const authReq = req as AuthenticatedRequest;
      const address = authReq.user?.stellarAddress ?? authReq.user?.address ?? authReq.user?.sub;
      if (typeof address === "string" && address.trim().length > 0) {
        return `user:${address.trim()}`;
      }
      return `ip:${getClientIp(req)}`;
    },
    ...options,
  });
}

/**
 * Pre-configured per-user rate limiter for `/api/webhooks` routes.
 *
 * Reads `WEBHOOKS_RATE_LIMIT_WINDOW_MS` and `WEBHOOKS_RATE_LIMIT_MAX` from
 * the environment; defaults to 100 requests per 15 minutes per user.
 */
export const webhooksRateLimiter = createPerUserTokenBucketLimiter({
  capacity: env.WEBHOOKS_RATE_LIMIT_MAX,
  refillWindowMs: env.WEBHOOKS_RATE_LIMIT_WINDOW_MS,
  keyGenerator: getUserRateKey,
});

/**
 * Pre-configured per-user rate limiter for `/api/fingerprint` route.
 */
export const fingerprintRateLimiter = createPerUserTokenBucketLimiter({
  capacity: env.FINGERPRINT_RATE_LIMIT_CAPACITY,
  refillWindowMs: env.FINGERPRINT_RATE_LIMIT_WINDOW_MS,
  keyGenerator: getUserRateKey,
});
