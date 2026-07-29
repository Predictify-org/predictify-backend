# Signup-Rate Anomaly Detector

Detects **signup floods** — bot registration waves, airdrop farming, sybil
onboarding — by comparing the recent signup rate against a robust baseline
learned from the preceding 24 hours.

The detector is **read-only**: it aggregates `users.created_at`, scores it, and
reports. Nothing is written, no migration is required, and re-running is free.

## Architecture

```
┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌────────────────┐
│ users.created │──▶│ densifyBuckets   │──▶│ computeBaseline  │──▶│ detectAnomalies│
│ _at (SQL agg) │   │ (zero-filled)    │   │ (median + MAD)   │   │ (pure)         │
└───────────────┘   └──────────────────┘   └──────────────────┘   └───────┬────────┘
                                                                          │
                                              ┌───────────────────────────┴───────┐
                                              ▼                                   ▼
                                     structured warn log                  Prometheus metrics
                                  ("signup flood detected")           (signup_anomalies_…)
```

* **Service** — [`src/services/anomalyDetector.ts`](../src/services/anomalyDetector.ts)
* **Worker** — [`src/workers/signupAnomalyDetector.ts`](../src/workers/signupAnomalyDetector.ts)
* **Tests** — `tests/anomalyDetector.test.ts`, `tests/signupAnomalyDetector.worker.test.ts`

## How a bucket is scored

1. **Bucket.** Signups are aggregated into fixed-width buckets (default 5 min),
   aligned to epoch multiples so boundaries are stable across runs. Gaps are
   zero-filled — a quiet night must count as a low sample, not a missing one.
2. **Baseline.** The buckets *before* the evaluation window feed a robust
   summary: **median** and **median absolute deviation (MAD)**.
3. **Score.** Each evaluation bucket gets a modified z-score
   (Iglewicz & Hoaglin): `0.6745 · (count − median) / spread`.
4. **Flag.** A bucket is anomalous when it clears the absolute floor **and** at
   least one relative rule fires.

### Why median/MAD rather than mean/stddev

A mean-and-stddev baseline is destroyed by the very thing being detected: one
large flood inflates both, so the *next* flood scores as normal. Median and MAD
have a 50 % breakdown point — a burst must consume half the baseline window
before it can hide itself. `tests/anomalyDetector.test.ts` pins this behaviour
("does not let an earlier flood poison the baseline for a later one").

### The Poisson noise floor

Signups are arrivals, so bucket counts are roughly Poisson: a stream averaging
λ per bucket varies by σ ≈ √λ from chance alone. An unusually flat baseline
(a run of exactly 12s) yields MAD = 0, which would make a bucket of 13 score as
maximally surprising. The observed spread is therefore floored at
`0.6745 · √median`. Spread only reaches zero when the baseline is *entirely
empty*, where any arrival genuinely is surprising — and `minCount` is what stops
that from paging anyone.

### Triggers

| Trigger | Fires when |
| --- | --- |
| `MODIFIED_Z_SCORE` | score ≥ `zThreshold` |
| `RATIO_TO_BASELINE` | `count / max(median, 1)` ≥ `ratioThreshold` |
| `COLD_START_BURST` | fewer than `minBaselineBuckets` of history; the absolute floor alone fired |

Severity is `critical` at twice either relative threshold, otherwise `warning`.

## Configuration

All knobs are optional and bounded by `signupAnomalyOptionsSchema`; out-of-range
values are rejected before any query runs.

| Option | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `bucketMs` | `300000` (5 min) | 1 min – 1 h | Bucket width |
| `baselineWindowMs` | `86400000` (24 h) | ≥ `bucketMs`, ≤ 7 d | History used to learn "normal" |
| `evaluationWindowMs` | `1800000` (30 min) | ≥ `bucketMs`, ≤ 24 h | Recent slice that gets scored |
| `zThreshold` | `3.5` | 1 – 100 | Modified z-score cutoff |
| `ratioThreshold` | `4` | 1 – 1000 | Multiple-of-median cutoff |
| `minCount` | `10` | 1 – 1 000 000 | Absolute floor; below this nothing alerts |
| `minBaselineBuckets` | `6` | 1 – 1000 | History required before relative rules are trusted |

A scan may never exceed **5000 buckets** (`MAX_BUCKETS_PER_SCAN`); combinations
that would are rejected with a validation error naming the limit.

## Usage

```ts
import {
  DrizzleSignupAnomalyRepo,
  runSignupAnomalyScan,
} from "./services/anomalyDetector";

const report = await runSignupAnomalyScan(new DrizzleSignupAnomalyRepo(), {
  bucketMs: 60_000,
  zThreshold: 3,
});
```

Or run the worker periodically:

```ts
import { signupAnomalyDetectorWorker } from "./workers/signupAnomalyDetector";

const stop = signupAnomalyDetectorWorker.start(5 * 60 * 1000);
```

`runOnce()` never throws — it logs and returns `null` — so it is safe to wire
into a scheduler. One-off run from the CLI:

```bash
node dist/workers/signupAnomalyDetector.js
```

### Report shape

```jsonc
{
  "window": {
    "since": "2026-07-23T11:35:00.000Z",
    "until": "2026-07-24T12:05:00.000Z",
    "evaluationSince": "2026-07-24T11:35:00.000Z",
    "bucketMs": 300000
  },
  "baseline": { "median": 12, "mad": 2, "meanAbsDev": 2.1, "sampleSize": 288 },
  "evaluated": 6,
  "totalSignups": 2148,
  "peak": { "bucketStart": "2026-07-24T11:50:00.000Z", "count": 1200 },
  "anomalies": [
    {
      "bucketStart": "2026-07-24T11:50:00.000Z",
      "bucketEnd": "2026-07-24T11:55:00.000Z",
      "count": 1200,
      "expected": 12,
      "ratio": 100,
      "score": 342.95,
      "severity": "critical",
      "triggers": ["MODIFIED_Z_SCORE", "RATIO_TO_BASELINE"]
    }
  ],
  "topScore": 342.95,
  "correlationId": "1c9f…"
}
```

Scores are capped at `1000` so the report stays JSON-safe (`Infinity`
serialises to `null`) and dashboards get a bounded axis.

## Observability

Structured logs (see [log-events.md](log-events.md) for conventions) — every
line carries the `correlationId`, taken from the caller, else the active request
context, else `null`:

| Message | Level | Emitted |
| --- | --- | --- |
| `signup_anomaly_scan: start` | info | Every scan, with the resolved window |
| `signup_anomaly_scan: complete` | info | Scan found nothing |
| `signup_anomaly_scan: signup flood detected` | **warn** | One or more anomalies — alert on this |
| `signup_anomaly_detector: run failed` | error | Worker swallowed an error |

Prometheus metrics (see [metrics.md](metrics.md)):

| Metric | Type | Labels |
| --- | --- | --- |
| `signup_anomaly_scans_total` | counter | — |
| `signup_anomalies_detected_total` | counter | `severity` |
| `signup_anomaly_top_score` | gauge | — |

Suggested alert: `increase(signup_anomalies_detected_total{severity="critical"}[10m]) > 0`.

## Security notes

* **No PII.** Only counts and timestamps are read; no addresses or user ids
  enter the report or the logs.
* **Parameterised SQL.** The bucket width and window bounds are bound as query
  parameters, never interpolated — asserted in
  `tests/anomalyDetector.test.ts` ("binds the bucket width and window instead of
  interpolating them").
* **Bounded work.** Aggregation happens in Postgres (`GROUP BY` on a bucketed
  epoch), so a 24 h window is 288 rows regardless of signup volume, and the
  bucket ceiling caps the worst case.
* **Not an enforcement point.** The detector observes; it does not block
  signups. Pair it with rate limiting ([rate-limiting.md](rate-limiting.md)) for
  mitigation.

## Tuning

* **Noisy alerts on a small deployment** — raise `minCount`. Most false
  positives come from a low-traffic baseline where a handful of organic signups
  look like a multiple of the median.
* **Slow, sustained ramps slipping through** — widen `bucketMs` (a 1 h bucket
  catches a ramp that a 5 min bucket absorbs) or lower `ratioThreshold`.
* **A recurring daily peak flagged every day** — the 24 h baseline includes the
  previous day's peak, so this usually self-corrects; if not, widen
  `baselineWindowMs`.
