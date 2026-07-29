/**
 * authMetrics.ts
 *
 * Express middleware that records per-request Prometheus metrics for the
 * /api/auth router.
 *
 * On every response finish event it:
 *   - Increments `auth_endpoint_requests_total{method, route, status}`
 *   - Observes into `auth_endpoint_duration_seconds{method, route, status}`
 *
 * The `route` label is derived from the matched Express route template
 * (e.g. `/challenge`, `/verify`, `/refresh`, `/logout`, `/wallet/logout`)
 * so label cardinality stays bounded even when future sub-paths are added.
 * Dynamic segments (UUIDs, numeric IDs) are normalised to `/:id` to
 * prevent unbounded cardinality.
 *
 * Registration: imported and applied via `authRouter.use(authMetricsMiddleware)`
 * near the top of src/routes/auth.ts, after the drain guard and before the
 * individual route handlers, so that all requests — including rejected ones
 * (rate-limited, timed out, validation errors) — are captured.
 */

import type { Request, Response, NextFunction } from "express";
import { authEndpointRequestsTotal, authEndpointDuration } from "./registry";

/**
 * Normalise a raw Express route template or path to a stable label value.
 *
 * Replaces:
 *   - UUID-shaped segments  →  /:id
 *   - Pure-numeric segments →  /:id
 *
 * Keeping named templates (e.g. `/challenge`, `/wallet/logout`) intact
 * ensures Prometheus cardinality remains bounded while still being useful.
 */
function sanitizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
}

/**
 * Prometheus metrics middleware for /api/auth.
 *
 * Attaches a `finish` listener to the response so timing and status are
 * recorded after the full response has been sent (including streaming bodies).
 * Using `process.hrtime.bigint()` for sub-millisecond precision.
 *
 * @example
 * // src/routes/auth.ts
 * import { authMetricsMiddleware } from "../metrics/authMetrics";
 * authRouter.use(authMetricsMiddleware);
 */
export function authMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    // Prefer the matched Express route template (e.g. "/challenge") over the
    // raw req.path so label values are stable across requests with identical
    // handlers. Fall back to req.path when route matching has not occurred
    // (e.g. for requests that were short-circuited by early-exit middleware).
    const routeTemplate: string = req.route?.path ?? req.path;
    const route = sanitizeRoute(routeTemplate);
    const method = req.method;
    const status = String(res.statusCode);

    authEndpointRequestsTotal.inc({ method, route, status });
    authEndpointDuration.observe({ method, route, status }, durationSec);
  });

  next();
}
