# Metrics

Predictify exposes Prometheus metrics at `GET /api/metrics`.

## Auth

If `METRICS_AUTH_TOKEN` is set, the endpoint requires a `Bearer` token:

```
Authorization: Bearer <token>
```

When the token is missing or invalid, the endpoint returns `401 Unauthorized` with a JSON error body.

If `METRICS_AUTH_TOKEN` is empty (default), the endpoint is unprotected.

## Metrics collected

### Default Node.js metrics

Collected by `prom-client`'s `collectDefaultMetrics`:

- `process_cpu_user_seconds_total`
- `process_cpu_system_seconds_total`
- `process_resident_memory_bytes`
- `node_heap_size_bytes`
- `node_event_loop_lag_seconds`
- and more

### Custom metrics

| Metric name | Type | Labels | Description |
|---|---|---|---|
| `http_request_duration_seconds` | Histogram | `route`, `status` | HTTP request duration in seconds, bucketed |
| `stats_request_duration_seconds` | Histogram | `route`, `status` | `/api/stats` request duration in seconds, bucketed. Observed for every request including ones rejected by rate limiting |
| `markets_request_duration_seconds` | Histogram | `endpoint`, `method`, `status` | `/api/markets` request duration in seconds, bucketed per endpoint (`list`, `search`, `featured`, `upcoming`, `get`, `patch`) |
| `markets_requests_total` | Counter | `endpoint`, `method`, `status` | Total `/api/markets` requests, segmented per endpoint (`list`, `search`, `featured`, `upcoming`, `get`, `patch`) |
| `indexer_polls_total` | Counter | — | Total indexer poll cycles completed |
| `webhook_deliveries_total` | Counter | `status` | Webhook deliveries by outcome |
| `auth_verifications_total` | Counter | `outcome` | Auth verification attempts by result |
| `signup_anomaly_scans_total` | Counter | — | Signup-rate anomaly scans completed ([signup-anomaly.md](signup-anomaly.md)) |
| `signup_anomalies_detected_total` | Counter | `severity` | Anomalous signup buckets detected (`warning`, `critical`) |
| `signup_anomaly_top_score` | Gauge | — | Highest modified z-score from the most recent signup scan |
| `endpoint_requests_total` | Counter | `method`, `route`, `status` | Per-endpoint request count |
| `endpoint_request_duration_seconds` | Histogram | `method`, `route`, `status` | Per-endpoint request duration in seconds, bucketed |

## Content type

The response uses `Content-Type: text/plain; charset=utf-8; version=0.0.4` (Prometheus exposition format).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `METRICS_AUTH_TOKEN` | `""` | Bearer token required to access `/api/metrics`. Empty means no auth |
