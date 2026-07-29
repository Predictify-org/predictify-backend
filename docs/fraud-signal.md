# Fraud Signal Detector

Background job that analyzes recent predictions, builds an address graph,
clusters suspicious addresses with **Union-Find**, and persists findings to
`fraud_flags` for admin review.

## Architecture

```
┌─────────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│  predictions, users │──▶ │  buildGraph (pure)   │──▶ │ clusterize (DSU) │
└─────────────────────┘    └──────────────────────┘    └────────┬─────────┘
                                                                │
                                                                ▼
                                                       ┌──────────────────┐
                                                       │  fraud_flags     │
                                                       │  (idempotent)    │
                                                       └────────┬─────────┘
                                                                │
                                                                ▼
                                                       ┌──────────────────┐
                                                       │ GET /api/admin/  │
                                                       │      fraud/flags │
                                                       └──────────────────┘
```

* **Graph builder** — `src/services/fraudService.ts :: buildGraph`. Pure
  function. Creates undirected edges between Stellar addresses for any of:
  * `SHARED_FUNDING_SOURCE` — same on-chain funder
  * `SHARED_TX_HASH` — two addresses appearing on the same transaction
  * `REPEATED_PATTERN` — identical (market, outcome, amount) bet inside the
    same 5-minute bucket
* **Clustering** — `clusterize` uses a classic Union-Find with path
  compression + union-by-rank. Components of size ≥ 2 become clusters.
* **Persistence** — `DrizzleFraudRepo.upsertFlags` writes one row per
  `(cluster, user)` with `ON CONFLICT DO UPDATE`, so re-running the scan
  is idempotent and refreshes evidence in-place.
* **Worker** — `src/workers/fraudDetector.ts`. `runOnce()` for ad-hoc or
  cron runs; `start(intervalMs)` for an in-process timer.
* **Admin endpoints** — `src/routes/admin/fraud.ts`:
  * `GET /api/admin/fraud/flags?status=open&limit=50` — paginated review
  * `POST /api/admin/fraud/scan` — manual trigger (admin only)

All endpoints require an admin JWT (`role: "admin"`) and are rate-limited
per-token (60 req/min by default).

## Schema

Migration `drizzle/migrations/0011_fraud_flags.sql`:

* Adds nullable `predictions.funding_source TEXT` (+ partial index).
* Creates `fraud_flags` with `(cluster_key, user_id)` unique index,
  status enum, evidence JSONB, score, and reviewer audit columns.

## Operational notes

* Correlation IDs flow from the request (or are generated per scan) into
  every log line and every persisted `fraud_flags.correlation_id`.
* The worker never throws — failures are logged and the next interval
  retries. This keeps the in-process scheduler stable.
* `MIN_CLUSTER_SIZE = 2` keeps noise low. Tune via the constant in
  `fraudService.ts` if needed.
* Default lookback is **24 h**, capped at 10 000 predictions per scan to
  protect memory on large datasets.

## Testing

```
npm test -- tests/fraudService.test.ts
npm test -- tests/fraudDetector.test.ts
npm test -- tests/adminFraud.test.ts
```

The suite covers graph builder edge types, union-find correctness, run
orchestration, worker scheduling & error handling, and the admin route
(auth, validation, happy path).
