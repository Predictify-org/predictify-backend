# Redis-backed Job Queue (BullMQ) — Issue #178

Slow, IO-bound, or externally-dependent jobs are moved off the request-handling
thread and processed by dedicated **BullMQ workers** backed by a Redis queue.
This keeps API latency low and gives every background task automatic retry,
backoff, and observability.

## Architecture overview

```
HTTP handler / scheduler
        │
        │  queue.add("job-name", payload)
        ▼
  Redis (BullMQ list)
        │
        │  Worker polls / subscribes
        ▼
  Worker process job
        │
        └─► success  → job removed from queue
        └─► failure  → BullMQ retries (up to configured attempts)
                     → permanent failure → dead-letter / logged
```

## Queue definitions — `src/queue/index.ts`

A **single shared Redis connection** (via `ioredis`) is created at startup and
reused by every queue and worker to avoid connection-pool bloat.

| Export | Queue name | Consumer worker |
|---|---|---|
| `webhookQueue` | `webhook-deliveries` | `WebhookWorker` |
| `backupVerificationQueue` | `backup-verification` | `BackupVerificationWorker` |
| `reconciliationQueue` | `reconciliation` | `ReconciliationWorker` |
| `marketResolutionQueue` | `market-resolution` | `MarketResolverWorker` |

```ts
// src/queue/index.ts (key excerpt)
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
});

export const webhookQueue            = new Queue("webhook-deliveries",    { connection: redisConnection });
export const backupVerificationQueue = new Queue("backup-verification",   { connection: redisConnection });
export const reconciliationQueue     = new Queue("reconciliation",        { connection: redisConnection });
export const marketResolutionQueue   = new Queue("market-resolution",     { connection: redisConnection });
```

## Workers — `src/workers/`

Each worker follows the same pattern:

- **Constructor** accepts a `concurrency` option and (where needed) injectable
  service / repository dependencies for testability.
- **`start()`** creates a `BullMQ.Worker` bound to its queue. Calling `start()`
  when already started is a safe no-op.
- **`stop()`** drains in-flight jobs gracefully via `worker.close()`.
- **`failed` event** is always hooked to emit a structured log entry with
  `jobId`, relevant domain IDs, and the error message.

### WebhookWorker

Processes `webhook-deliveries` jobs. Each job carries a `deliveryId`:

1. Fetches the delivery row; skips if already `success` or `terminal`.
2. Looks up the subscription endpoint and secret.
3. Calls `attemptDelivery` (HMAC-signed POST).
4. On failure, re-enqueues with a `delay` calculated from `nextRetryAt`
   (exponential backoff stored by the dispatcher).

```ts
// Enqueuing a webhook delivery
await webhookQueue.add("deliver", { deliveryId: "uuid" }, { delay: 0 });
```

### BackupVerificationWorker

Processes `backup-verification` jobs. Instantiates the `BackupVerifier` via an
injectable factory and runs `verifier.run()`. Throws on failure, which causes
BullMQ to mark the job as failed and log the error.

```ts
// Triggering a backup verification (e.g., from a cron scheduler)
await backupVerificationQueue.add("verify", {});
```

### ReconciliationWorker

Processes `reconciliation` jobs with a discriminated payload:

| `type` | Required fields | Delegates to |
|---|---|---|
| `"global"` | — | `performReconciliation()` |
| `"market"` | `marketId`, `adminAddress`, `ip`, `correlationId` | `reconcileMarket()` |

Unknown types throw immediately, so malformed jobs fail fast and are never
silently swallowed.

```ts
// Global reconciliation
await reconciliationQueue.add("reconcile", { type: "global" });

// Single-market reconciliation (admin-triggered)
await reconciliationQueue.add("reconcile", {
  type: "market",
  marketId: "mkt-abc",
  adminAddress: "GABC…",
  ip: "1.2.3.4",
  correlationId: req.id,
});
```

### MarketResolverWorker

Processes `market-resolution` jobs. Each job carries a `MarketResolvedEvent`
(marketId, winningOutcome, ledger, timestamp). The worker:

1. Calls `resolveMarket(repo, event, emitWebhook)` — an idempotent atomic
   update that resolves predictions and fans out webhooks.
2. Idempotency is enforced at the DB layer: if the market is already resolved
   the worker returns without error.

```ts
// Via MarketResolverWorker.handleEvent (called from the indexer)
await marketResolverWorker.handleEvent({
  marketId: "mkt-sol-100",
  winningOutcome: "YES",
  ledger: 99_000,
  timestamp: 1_700_000_000,
});
```

## Startup & shutdown — `src/index.ts`

Workers and the reconciliation scheduler are started after the database
connection is established and stopped gracefully on `SIGTERM` / `SIGINT`:

```ts
connectWithRetry().then(() => {
  webhookWorker.start();
  marketResolverWorker.start();
  backupVerificationWorker.start();
  reconciliationWorker.start();
  initializeScheduler();
  app.listen(…);
});

process.on("SIGTERM", async () => {
  stopScheduler();
  await Promise.all([
    webhookWorker.stop(),
    marketResolverWorker.stop(),
    backupVerificationWorker.stop(),
    reconciliationWorker.stop(),
  ]);
  // …close DB, exit 0
});
```

## Reconciliation Scheduler — `src/services/scheduler.ts`

When `RECONCILIATION_ENABLED` is `true` (`true`/`1`/`yes`, case-insensitive),
`initializeScheduler()` schedules periodic global reconciliation jobs on
`reconciliationQueue` according to `RECONCILIATION_SCHEDULE` (default:
`0 2 * * *`).

### Supported 5-field cron syntax & UTC semantics

`RECONCILIATION_SCHEDULE` is validated at boot (`src/config/env-schema.ts`) and
when `scheduler.schedule()` is called using a dependency-free 5-field parser:

```text
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6, where 0 = Sunday)
│ │ │ │ │
* * * * *
```

- **Operators supported per field:**
  - Wildcard: `*`
  - Exact integer: `n` (e.g. `0`, `15`)
  - Inclusive range: `a-b` (e.g. `1-5`)
  - Step on wildcard or range: `*/n` or `a-b/n` (e.g. `*/15`, `8-18/2`)
  - Comma-separated list: `a,b,c` combining any of the above (e.g. `0,30`, `1-5,10`)
- **Calendar validation:** Impossible day/month combinations (such as `0 0 30 2 *` or `0 0 31 4 *`) are rejected at parse time; leap-day schedules (`0 0 29 2 *`) are permitted.
- **UTC evaluation:** All cron fields and slot calculations are evaluated strictly in **UTC** (`getUTCMinutes`, `getUTCHours`, `getUTCDate`, `getUTCMonth`, `getUTCDay`), independent of the host server's local timezone.
- **Slot-based firing & replica deduplication:** Instead of polling every 60 seconds, the scheduler computes the next matching UTC minute boundary (`nextCronSlot`), arms a single `setTimeout` for that slot, guards against duplicate in-process execution per slot, and enqueues onto `reconciliationQueue` with a deterministic `jobId`:
  `reconciliation:<YYYY-MM-DDTHH:mmZ>` (for example, `reconciliation:2026-10-18T02:00Z`).
  When multiple backend replicas fire on the same slot, BullMQ deduplicates by `jobId` so only one global reconciliation job runs per slot.
- **Observability:** Next fire time is logged whenever a task is armed, and each slot execution increments the Prometheus counter `scheduler_runs_total{task,outcome}` (`outcome="enqueued" | "deduped" | "error"`).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | ✅ | `redis://…` connection string used by BullMQ |
| `RECONCILIATION_ENABLED` | Optional (`false`) | Strict boolean (`true`/`false`/`1`/`0`/`yes`/`no`, case-insensitive) enabling scheduled global reconciliation |
| `RECONCILIATION_SCHEDULE` | Optional (`0 2 * * *`) | 5-field UTC cron schedule for global reconciliation |

Add `REDIS_URL=redis://localhost:6379` to your `.env` (already in
`.env.example`).

## Running locally

```bash
# Start a local Redis instance (Docker)
docker run -p 6379:6379 redis:7-alpine

# Copy env, set REDIS_URL
cp .env.example .env
# REDIS_URL=redis://localhost:6379

npm install
npm run dev
```

## Testing

All workers and the queue module itself are fully tested with Jest mocks for
`ioredis` and `bullmq`, so **no real Redis instance is needed in CI**:

```bash
npm test -- tests/queue.test.ts              # queue exports
npm test -- tests/webhookWorker.test.ts      # WebhookWorker start/stop
npm test -- tests/backupVerificationWorker.test.ts  # job processor callbacks
npm test -- tests/reconciliationWorker.test.ts      # global + market + edge cases
npm test -- tests/marketResolver.test.ts            # resolveMarket + worker + in-memory repo
```

### Test strategy

| File | What is covered |
|---|---|
| `queue.test.ts` | Redis connection is created; all four queues are exported with the correct names |
| `webhookWorker.test.ts` | Worker is instantiated with the right concurrency; `close()` is called on stop |
| `backupVerificationWorker.test.ts` | Success path returns result; failure path throws; start/stop lifecycle |
| `reconciliationWorker.test.ts` | Global path; market path; missing-field validation; unknown type guard |
| `marketResolver.test.ts` | `resolveMarket()` service unit tests; in-memory fixture tests for won/lost classification; worker enqueue + processor |

## Structured logging

Every worker emits **pino** log entries at key lifecycle events. All log entries
include a domain-specific correlation field (e.g. `deliveryId`, `jobId`,
`marketId`) so they can be correlated across a distributed trace.

| Logger call | Fields |
|---|---|
| Worker start | `concurrency` |
| Job processed | `jobId` + domain IDs |
| Job completed | `jobId` + domain IDs + outcome |
| Job failed | `jobId` + domain IDs + `err` (message only — no stack in prod) |
| Worker stop | — |

## Security considerations

- **Input validation at enqueue time.** Callers (scheduler, admin routes, indexer)
  are responsible for validating data before calling `queue.add`. Workers perform
  defensive checks (e.g., missing delivery, unknown job type) and fail the job
  explicitly rather than silently accepting bad data.
- **Redis credentials.** `REDIS_URL` should include auth when connecting to a
  managed Redis service. Use secrets manager / environment injection; never
  commit credentials.
- **Job payload size.** Payloads should be kept small — store only IDs or
  minimal event data; fetch full records inside the worker.
