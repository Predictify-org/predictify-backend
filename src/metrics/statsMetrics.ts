import type { Request, Response, NextFunction } from "express";
import { statsRequestDuration } from "./registry";

/**
 * Records request latency for /api/stats into the `stats_request_duration_seconds`
 * histogram (see metrics/registry.ts), segmented by route template and status code.
 *
 * Registered ahead of rate limiting / auth on the router so that latency for
 * rejected requests (e.g. 429 from rateLimitAnon) is captured as well, not
 * just successful 200s.
 */
export function statsMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    // /api/stats currently has a single route ("/"); fall back to req.path
    // defensively in case that ever changes (e.g. future sub-resources).
    const route: string = req.route?.path || req.path;
    const status = String(res.statusCode);

    statsRequestDuration.observe({ route, status }, durationSec);
  });

  next();
}
