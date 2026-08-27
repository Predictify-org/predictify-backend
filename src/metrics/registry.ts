import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds, segmented by route template and status code",
  labelNames: ["route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const webhookRequestDuration = new Histogram({
  name: "webhook_request_duration_seconds",
  help: "Latency of /api/webhooks requests in seconds",
  labelNames: ["route"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], // Explicit buckets for latency tracking
  registers: [register],
});

export const statsRequestDuration = new Histogram({
  name: "stats_request_duration_seconds",
  help: "Latency of /api/stats requests in seconds, segmented by route and status code",
  labelNames: ["route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10], // Explicit buckets for latency tracking
  registers: [register],
});

export const leaderboardRequestDuration = new Histogram({
  name: "leaderboard_request_duration_seconds",
  help: "Latency of /api/leaderboard requests in seconds, segmented by route and status code",
  labelNames: ["route", "status"] as const,
  // Wider tail than stats' buckets: leaderboard reads can trigger a
  // synchronous materialized-view REFRESH via ?refresh=true, which is
  // bounded by LEADERBOARD_TIMEOUT_MS (5s) but routinely slower than a
  // plain read.
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const indexerPollsTotal = new Counter({
  name: "indexer_polls_total",
  help: "Total number of indexer poll cycles completed",
  registers: [register],
});

export const indexerLagLedgers = new Gauge({
  name: "indexer_lag_ledgers",
  help: "Current lag in ledgers between the indexer cursor and the chain tip",
  registers: [register],
});

export const scheduledReportRunsTotal = new Counter({
  name: "scheduled_report_runs_total",
  help: "Scheduled report runs by terminal outcome",
  labelNames: ["status"] as const,
  registers: [register],
});

export const scheduledReportRetriesTotal = new Counter({
  name: "scheduled_report_retries_total",
  help: "Scheduled report retry attempts by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const scheduledReportLeaseConflictsTotal = new Counter({
  name: "scheduled_report_lease_conflicts_total",
  help: "Scheduled report jobs skipped because another worker owns the lease",
  registers: [register],
});

export const webhookDeliveriesTotal = new Counter({
  name: "webhook_deliveries_total",
  help: "Total number of webhook deliveries, segmented by outcome status (success, failed)",
  labelNames: ["status"] as const,
  registers: [register],
});

export const authVerificationsTotal = new Counter({
  name: "auth_verifications_total",
  help: "Total number of authentication verification attempts, segmented by outcome (success, failure)",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const settleConfirmerPollsTotal = new Counter({
  name: "settle_confirmer_polls_total",
  help: "Total number of settle-confirmer poll cycles completed",
  registers: [register],
});

export const settleConfirmerSettledTotal = new Counter({
  name: "settle_confirmer_settled_total",
  help: "Total number of claims marked as settled by the settle-confirmer",
  registers: [register],
});

export const settleConfirmerFailedTotal = new Counter({
  name: "settle_confirmer_failed_total",
  help: "Total number of claims permanently marked as failed by the settle-confirmer",
  registers: [register],
});

export const signupAnomalyScansTotal = new Counter({
  name: "signup_anomaly_scans_total",
  help: "Total number of signup-rate anomaly scans completed",
  registers: [register],
});

export const signupAnomaliesDetectedTotal = new Counter({
  name: "signup_anomalies_detected_total",
  help: "Total number of anomalous signup buckets detected, segmented by severity (warning, critical)",
  labelNames: ["severity"] as const,
  registers: [register],
});

export const signupAnomalyTopScore = new Gauge({
  name: "signup_anomaly_top_score",
  help: "Highest modified z-score observed in the most recent signup-rate anomaly scan",
  registers: [register],
});

export const marketsRequestDuration = new Histogram({
  name: "markets_request_duration_seconds",
  help: "Duration of /api/markets requests in seconds, segmented by route, method, and status code",
  labelNames: ["route", "method", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const webhooksEndpointRequestsTotal = new Counter({
  name: "webhooks_endpoint_requests_total",
  help: "Total number of requests to /api/webhooks endpoints, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const webhooksEndpointDuration = new Histogram({
  name: "webhooks_endpoint_duration_seconds",
  help: "Request duration in seconds for /api/webhooks endpoints, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const usersEndpointRequestsTotal = new Counter({
  name: "users_endpoint_requests_total",
  help: "Total number of requests to /api/users endpoints, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const usersEndpointDuration = new Histogram({
  name: "users_endpoint_duration_seconds",
  help: "Request duration in seconds for /api/users endpoints, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const endpointRequestsTotal = new Counter({
  name: "endpoint_requests_total",
  help: "Total number of requests per endpoint, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const endpointRequestDuration = new Histogram({
  name: "endpoint_request_duration_seconds",
  help: "Request duration in seconds per endpoint, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const sloViolationsTotal = new Counter({
  name: "slo_violations_total",
  help: "Total SLO violations, segmented by method, route, and type (latency or error)",
  labelNames: ["method", "route", "type"] as const,
  registers: [register],
});

/**
 * Per-endpoint request counter for /api/auth routes.
 *
 * Labels:
 *   method — HTTP verb (POST, GET, …)
 *   route  — Express route template (e.g. /challenge, /verify, /refresh,
 *             /logout, /wallet/logout); dynamic path segments such as UUIDs
 *             and numeric IDs are normalised to /:id by the middleware.
 *   status — HTTP response status code as a string (e.g. "200", "422", "429")
 */
export const authEndpointRequestsTotal = new Counter({
  name: "auth_endpoint_requests_total",
  help: "Total number of requests to /api/auth endpoints, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

/**
 * Per-endpoint request latency histogram for /api/auth routes.
 *
 * Labels match authEndpointRequestsTotal so counter and histogram can be
 * joined in PromQL / Grafana dashboards without additional relabelling.
 *
 * Buckets (seconds) are tuned for auth flows: most successful challenge +
 * verify pairs complete in < 100 ms; the 10 s upper bound catches edge-case
 * timeouts before the 15 s route-level deadline fires.
 */
export const authEndpointDuration = new Histogram({
  name: "auth_endpoint_duration_seconds",
  help: "Request duration in seconds for /api/auth endpoints, segmented by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});
