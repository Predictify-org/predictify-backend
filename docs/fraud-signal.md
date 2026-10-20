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
  * `PATCH /api/admin/fraud/flags/:id` — review transitions (`open→confirmed|dismissed`, `confirmed→dismissed` with note; `dismissed` is terminal). Invalid transitions return `409` with code `invalid_transition`; missing/required-note validation return `400` with code `validation_error`. Every transition creates an `audit_logs` entry with action `fraud_flag.review` (note stored in audit metadata only).Concurrent updates use optimistic status checks. 

All endpoints require an admin JWT (`role: "admin"`) and are rate-limited
per-token (60 req/min by default).

## Schema

Migration `drizzle/migrations/0011_fraud_flags.sql`:

* Adds nullable `predictions.funding_source TEXT` (+ partial index).
* Creates `fraud_flags` with `(cluster_key, user_id)` unique index,
  status enum, evidence JSONB, score, and reviewer audit columns.

Migration `drizzle/migrations/0031_fraud_flags_carried_from.sql`:

* Adds `fraud_flags.carried_from` UUID FK → `fraud_flags(id)` (ON DELETE SET NULL)
  to track when a re-detected finding inherits a prior dismissal.

## Carry-forward behavior

When `runFraudScan` detects a finding for a user who already has the most
recent `dismissed` flag, it compares the new evidence's reason set against
the prior dismissal's reasons. If the new reasons are a subset of the prior
reasons (no new signal type appeared), the new flag is written as
`status='dismissed'` with `carried_from` set to the prior dismissal's id. If
any new reason appears, the finding is reopened as `status='open'`. Cluster
keys are SHA-256 of sorted member addresses (`|`-joined) for new scans. 

## Worker

`src/workers/fraudDetector.ts` supports:
* `node dist/workers/fraudDetector.js` for one-off scans (exits on completion)
* `FRAUD_DETECTOR_INTERVAL_MS=<ms>` for recurring runs with SIGINT/SIGTERM
  graceful shutdown (timer stopped, DB pool closed with timeout)
* `npm run fraud-detector` / `npm run fraud-detector:dev` scripts

## Operational notes

* Correlation IDs flow from the request (or are generated per scan) into
  every log line and every persisted `fraud_flags.correlation_id`. Routes
  echo `x-correlation-id` and `x-request-id` on responses.
* The worker never throws — failures are logged and the next interval
  retries. This keeps the in-process scheduler stable.
* `MIN_CLUSTER_SIZE = 2` keeps noise low. Tune via the constant in
  `fraudService.ts` if needed.
* Default lookback is **24 h**, capped at 10 000 predictions per scan to
  protect memory on large datasets.
* `DrizzleFraudRepo` transition updates never touch `status/reviewedBy` via
  `ON CONFLICT DO UPDATE` (idempotent re-scan / audit integrity).

## Testing

```
npm test -- tests/fraudService.test.ts
npm test -- tests/fraudDetector.test.ts
npm test -- tests/adminFraud.test.ts
```

The suite covers graph builder edge types, union-find correctness, run
orchestration, worker scheduling & error handling, and the admin route
(auth, validation, happy path).
