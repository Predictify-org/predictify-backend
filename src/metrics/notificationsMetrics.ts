import type { Request, Response, NextFunction } from "express";
import {
  notificationsEndpointRequestsTotal,
  notificationsEndpointDuration,
} from "./registry";

function sanitizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
}

/**
 * Express middleware that records per-request Prometheus metrics for the
 * /api/notifications router.
 *
 * On every response:
 *  - Increments `notifications_endpoint_requests_total{method, route, status}`
 *  - Observes into `notifications_endpoint_duration_seconds{method, route, status}`
 *
 * The `route` label is derived from the matched Express route template
 * (e.g. `/preferences`, `/mark-read`) so cardinality stays bounded even if
 * path segments contain dynamic values.
 */
export function notificationsMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const routeTemplate: string = req.route?.path || req.path;
    const route = sanitizeRoute(routeTemplate);
    const method = req.method;
    const status = String(res.statusCode);

    notificationsEndpointRequestsTotal.inc({ method, route, status });
    notificationsEndpointDuration.observe({ method, route, status }, durationSec);
  });

  next();
}
