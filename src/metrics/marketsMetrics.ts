import type { Request, Response, NextFunction } from "express";
import { marketsRequestDuration } from "./registry";

function sanitizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
}

/**
 * Records request latency for /api/markets into the
 * `markets_request_duration_seconds` histogram (see metrics/registry.ts),
 * segmented by route template, method, and status code.
 *
 * Registered ahead of rate limiting / auth on the router so that latency
 * for rejected requests (e.g. 429 from rateLimitAnon) is captured as well,
 * not just successful 200s.
 */
export function marketsMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const routeTemplate: string = req.route?.path
      ? (req.baseUrl || "") + req.route.path
      : req.path;

    const route = sanitizeRoute(routeTemplate);
    const method = req.method;
    const status = String(res.statusCode);

    marketsRequestDuration.observe({ route, method, status }, durationSec);
  });

  next();
}