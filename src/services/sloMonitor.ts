import { Counter } from "prom-client";
import { register, sloViolationsTotal } from "../metrics/registry";
import { Request, Response } from "express";
import { sloConfigMap } from "../config/slo";

// Counter for total requests per endpoint (optional, for internal tracking)
const requestCounter = new Counter({
  name: "slo_requests_total",
  help: "Total requests observed by SLO monitor",
  labelNames: ["method", "route"] as const,
  registers: [register],
});

export interface SLOConfig {
  /** maximum allowed latency in seconds */
  latencySec?: number;
  /** maximum allowed error rate (fraction, e.g., 0.01 for 1%) */
  errorRate?: number;
  /** window size in seconds for evaluating error rate */
  windowSec?: number;
}

interface RequestSample {
  timestamp: number;
  isError: boolean;
}

const requestBuckets: Record<string, RequestSample[]> = {};

export class SLOMonitor {
  /** Record a request and evaluate SLOs */
  record(req: Request, res: Response, durationSec: number, route?: string): void {
    const finalRoute = route ?? (req.baseUrl || "") + (req.route?.path || req.path);
    const method = req.method;
    const key = `${method}:${finalRoute}`;

    // Increment request counter
    requestCounter.inc({ method, route: finalRoute });

    // Load config (fallback to default "*" entry)
    const cfg: SLOConfig = sloConfigMap[finalRoute] ?? sloConfigMap["*"] ?? {};

    // Latency check
    if (cfg.latencySec !== undefined && durationSec > cfg.latencySec) {
      sloViolationsTotal.inc({ method, route: finalRoute, type: "latency" });
      console.warn(`[SLOMonitor] Latency violation on ${method} ${finalRoute}: ${durationSec}s > ${cfg.latencySec}s`);
    }

    // Error-rate check (status >= 400 is considered an error)
    if (cfg.errorRate !== undefined) {
      const status = res.statusCode;
      const isError = status >= 400;
      const now = Date.now();

      const samples = (requestBuckets[key] ??= []);
      samples.push({ timestamp: now, isError });

      // Keep only samples within the configured window
      const windowSec = cfg.windowSec ?? 300;
      const cutoff = now - windowSec * 1000;

      // Filter out old samples
      const activeSamples = samples.filter((s) => s.timestamp >= cutoff);
      requestBuckets[key] = activeSamples;

      const totalRequests = activeSamples.length;
      const errorRequests = activeSamples.filter((s) => s.isError).length;
      const errorRate = totalRequests > 0 ? errorRequests / totalRequests : 0;

      if (errorRate > cfg.errorRate) {
        sloViolationsTotal.inc({ method, route: finalRoute, type: "error" });
        console.warn(
          `[SLOMonitor] Error-rate violation on ${method} ${finalRoute}: ${(errorRate * 100).toFixed(2)}% (${errorRequests}/${totalRequests}) > ${(cfg.errorRate * 100).toFixed(2)}% in ${windowSec}s`
        );
      }
    }
  }

  /** Clear all tracked request buckets (mainly for unit tests) */
  clear(): void {
    for (const key of Object.keys(requestBuckets)) {
      delete requestBuckets[key];
    }
  }
}

export const sloMonitor = new SLOMonitor();
