import type { Request, Response, NextFunction } from "express";
import { leaderboardRequestDuration } from "./registry";

/**
 * Records request latency for /api/leaderboard into the
 * `leaderboard_request_duration_seconds` histogram (see metrics/registry.ts),
 * segmented by route template and status code.
 *
 * Registered ahead of the request timeout / rate limiting on the router so
 * that latency for rejected or timed-out requests (e.g. 429 from
 * rateLimitAnon, 504 from the leaderboard timeout guard) is captured too,
 * not just successful 200s.
 */
export function leaderboardMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    // Prefer the matched Express route template (e.g. "/user/:stellarAddress")
    // over the raw req.path so label values stay stable and low-cardinality
    // across requests with identical handlers.
    const route: string = req.route?.path ?? req.path;
    const status = String(res.statusCode);

    leaderboardRequestDuration.observe({ route, status }, durationSec);
  });

  next();
}
