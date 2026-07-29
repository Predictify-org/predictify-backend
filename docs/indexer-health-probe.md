# Indexer Health Probe

## Overview

A periodic background probe that checks the indexer's lag every **60 seconds** and emits a structured alert log when the lag exceeds a configurable threshold.

**Lag** is defined as:

```
lag = chain tip (latest ledger from Soroban RPC) − last indexed ledger (indexer_cursor table)
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `INDEXER_LAG_ALERT_THRESHOLD` | `200` | Ledger lag above which a `warn`-level alert is emitted. |

Set in `.env`:

```dotenv
INDEXER_LAG_ALERT_THRESHOLD=200
```

---

## Behaviour

| Condition | Log level | Event |
|---|---|---|
| `lag ≤ threshold` | `debug` | `indexer.lag_ok` |
| `lag > threshold` | `warn` | `indexer.lag_threshold_breached` |
| Fetch error (DB or RPC) | `error` | `indexer_health_probe_fetch_failed` |

The probe fires **once immediately** at startup, then every 60 seconds.

---

## Alert log shape

```json
{
  "level": "warn",
  "event": "indexer.lag_threshold_breached",
  "lag": 450,
  "cursor": 550,
  "chainTip": 1000,
  "threshold": 200,
  "msg": "indexer lag exceeds threshold — investigate backfill or RPC connectivity"
}
```

---

## Prometheus metric

| Metric | Type | Labels | Description |
|---|---|---|---|
| `indexer_lag_ledgers` | Gauge | — | Current lag in ledgers, updated on every probe tick. |

Query example (Prometheus):

```promql
indexer_lag_ledgers > 200
```

---

## Lifecycle

The probe is started in `src/index.ts` after the DB connection is established, and its interval handle is cleared on `SIGTERM` / `SIGINT` as part of graceful shutdown.

```
startup → connectWithRetry() → startIndexerHealthProbe()
shutdown → stopIndexerHealthProbe(handle) → stopScheduler() → closeDb()
```

---

## Implementation

- **Job**: `src/jobs/indexerHealthProbe.ts`
- **Metric**: `src/metrics/registry.ts` — `indexerLagLedgers` Gauge
- **Config**: `src/config/env.ts` — `INDEXER_LAG_ALERT_THRESHOLD`
- **Tests**: `tests/indexerHealthProbe.test.ts`
