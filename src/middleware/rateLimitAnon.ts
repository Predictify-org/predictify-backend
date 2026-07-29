/**
 * Anonymous sliding-window rate limiter.
 *
 * Applies per-IP throttling to public read routes (/api/markets, /api/leaderboard).
 * Authenticated callers (Bearer token present) bypass the limiter so logged-in
 * users are not penalised for shared NAT egress.
 *
 * Configuration (env):
 *   ANON_RATE_LIMIT_WINDOW_MS  — sliding window length (default 60_000)
 *   ANON_RATE_LIMIT_MAX        — max requests per IP per window (default 60)
 *   TRUST_PROXY                — honour X-Forwarded-For when true (default false)
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

/** In-memory sliding-window store keyed by client IP. */
export class SlidingWindowStore {
  private readonly buckets = new Map<string, number[]>();

  /** Returns timestamps still inside the window for `key`. */
  getTimestamps(key: string, now: number, windowMs: number): number[] {
    const existing = this.buckets.get(key) ?? [];
    const cutoff = now - windowMs;
    const active = existing.filter((ts) => ts > cutoff);
    if (active.length === 0) {
      this.buckets.delete(key);
    } else {
      this.buckets.set(key, active);
    }
    return active;
  }

  /** Records a request timestamp for `key`. */
  record(key: string, timestamp: number, windowMs: number): void {
    const active = this.getTimestamps(key, timestamp, windowMs);
    active.push(timestamp);
    this.buckets.set(key, active);
  }

  /** Test helper — clears all buckets. */
  clear(): void {
    this.buckets.clear();
  }
}

export interface RateLimitAnonOptions {
  windowMs: number;
  max: number;
  /** When true, client IP is taken from X-Forwarded-For (first valid hop). */
  trustProxy?: boolean;
  store?: SlidingWindowStore;
}

const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

/** Normalises IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1). */
export function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

/** Validates a single IP literal (IPv4 or IPv6). */
export function isValidIp(value: string): boolean {
  const ip = normalizeIp(value);
  if (IPV4_RE.test(ip)) return true;
  if (ip.includes(":") && IPV6_RE.test(ip)) return true;
  return false;
}

/**
 * Extracts the client IP safely.
 *
 * X-Forwarded-For is only trusted when `trustProxy` is enabled so callers
 * cannot spoof their IP by setting the header directly.
 */
export function extractClientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const raw = Array.isArray(xff) ? xff[0] : xff;
      const firstHop = raw.split(",")[0]?.trim();
      if (firstHop && isValidIp(firstHop)) {
        return normalizeIp(firstHop);
      }
    }
  }

  const socketIp = req.socket.remoteAddress;
  if (socketIp && isValidIp(socketIp)) {
    return normalizeIp(socketIp);
  }

  if (req.ip && isValidIp(req.ip)) {
    return normalizeIp(req.ip);
  }

  return "unknown";
}

/** Returns true when the caller presents a Bearer token (authenticated). */
export function isAuthenticatedRequest(req: Request): boolean {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") && auth.length > 7;
}

/** Seconds until the oldest timestamp in the window expires. */
export function retryAfterSeconds(oldestTimestamp: number, now: number, windowMs: number): number {
  const remainingMs = oldestTimestamp + windowMs - now;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

export function createRateLimitAnon(options: RateLimitAnonOptions): RequestHandler {
  const { windowMs, max, trustProxy = false, store = new SlidingWindowStore() } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthenticatedRequest(req)) {
      next();
      return;
    }

    const now = Date.now();
    const clientIp = extractClientIp(req, trustProxy);
    const key = clientIp;
    const active = store.getTimestamps(key, now, windowMs);

    if (active.length >= max) {
      const retryAfter = retryAfterSeconds(active[0]!, now, windowMs);
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
        "anon_rate_limit_exceeded",
      );

      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: {
          code: "rate_limit_exceeded",
          ...(getRequestId() ? { requestId: getRequestId() } : {}),
        },
      });
      return;
    }

    store.record(key, now, windowMs);
    next();
  };
}

/** Shared store instance used by the default limiter and the status endpoint. */
export const anonRateLimitStore = new SlidingWindowStore();

/** Production middleware wired from env defaults. */
export const rateLimitAnon = createRateLimitAnon({
  windowMs: env.ANON_RATE_LIMIT_WINDOW_MS,
  max: env.ANON_RATE_LIMIT_MAX,
  trustProxy: env.TRUST_PROXY,
  store: anonRateLimitStore,
});
