# Metrics endpoint

Predictify exposes Prometheus-formatted metrics at:

- `GET /api/metrics`
- `GET /metrics` for compatibility with existing local tooling

Set `METRICS_AUTH_TOKEN` to require a bearer token:

```bash
METRICS_AUTH_TOKEN=replace-with-random-secret
curl -H "Authorization: Bearer replace-with-random-secret" http://localhost:3001/api/metrics
```

If `METRICS_AUTH_TOKEN` is unset, the endpoint remains public. This is useful in
local development, but production deployments should set the token.

The response uses `prom-client`'s Prometheus text format and includes:

- default Node.js process metrics from `collectDefaultMetrics`
- `http_request_duration_seconds`
- `indexer_polls_total`
- `webhook_deliveries_total`
- `auth_verifications_total`
