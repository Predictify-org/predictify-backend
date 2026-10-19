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
- **Metric**: `src/metrics/registry.ts` — `indexerLagLedgers` Gauge, `indexer_events_inserted_total`, `indexer_reorgs_detected_total` Counters
- **Config**: `src/config/env.ts` — `INDEXER_LAG_ALERT_THRESHOLD`
- **Tests**: `tests/indexerHealthProbe.test.ts`, `tests/indexerService.recovery.test.ts`, `tests/integration/indexerPersistence.test.ts`

---

## Event Identity and Reorganization Recovery

Soroban RPC emits events whose `id` adheres to the format `<toid>-<event_index>`:
- **TOID prefix (64-bit integer)**:
  - Ledger sequence: bits 32..63 (32 bits)
  - Transaction application order: bits 12..31 (20 bits)
  - Operation index: bits 0..11 (12 bits)
- **Event index suffix**: 10-digit zero-padded index of the event within its operation.

### Identity vs. Position

- **Event Identity**: `(ledger, tx_hash, op_index, event_index)` uniquely identifies an immutable event record across re-deliveries.
- **Ledger Position**: `(ledger, tx_application_order, op_index, event_index)` defines the exact execution slot in the ledger.

### Atomic Reorganization Replacement

When a new transaction appears at an already indexed ledger position with a different transaction hash (`SELECT ... FOR UPDATE`), a true reorganization has occurred:
1. The stale event is marked non-canonical (`canonical = false`).
2. Predictions linked to the reorganized transaction hash are reset to `status = 'pending'`, with results cleared.
3. A reorganization record is inserted into `indexer_reorgs` with `repaired_predictions` count.
4. The new event is inserted with `canonical = true`.
5. The entire transition executes inside a single database transaction (`BEGIN ... COMMIT`), guaranteeing atomicity and preventing false reorgs between distinct transactions in the same ledger.
