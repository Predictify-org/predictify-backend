import type { Request, Response, NextFunction } from "express";
import { webhooksEndpointRequestsTotal, webhooksEndpointDuration } from "./registry";

function sanitizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
}

export function webhooksMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const routeTemplate: string = req.route?.path || req.path;

    const route = sanitizeRoute(routeTemplate);
    const method = req.method;
    const status = String(res.statusCode);

    webhooksEndpointRequestsTotal.inc({ method, route, status });
    webhooksEndpointDuration.observe({ method, route, status }, durationSec);
  });

  next();
}
