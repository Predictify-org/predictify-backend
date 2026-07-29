# Reconciliation runbook

## Purpose

Use the admin reconciliation endpoint to inspect a single market and compare the
backend's database snapshot with the available on-chain snapshot.

The endpoint is **on-demand and read-only** — it never mutates state. Run it any
time you suspect a discrepancy between what Predictify's database has recorded
and what the Soroban contract holds on-chain.

---

## Endpoint

```
GET /api/admin/recon/markets/:id
```

### Security

- Admin-only route guarded by the existing bearer JWT admin middleware
  (`requireAdmin`). The JWT must carry `role: "admin"`.
- Every call is audit-logged as `admin.reconciliation.market.inspect` with the
  caller's wallet address, IP, and correlation ID.
- Correlate the request with the `x-request-id` response header and the
  `correlationId` field in the JSON payload.

### Request

```bash
curl --request GET \
  --url https://<host>/api/admin/recon/markets/<MARKET_ID> \
  --header 'Authorization: Bearer <admin-jwt>' \
  --header 'X-Request-Id: recon-<uuid>'
```

Supply `X-Request-Id` with a stable identifier so the log entry and the JSON
response both carry the same correlation token.

### Success response (`200 OK`)

```json
{
  "data": {
    "marketId": "abc123",
    "correlationId": "recon-market-abc123",
    "generatedAt": "2026-06-27T12:00:00.000Z",
    "status": "ok",
    "dbSnapshot": {
      "positions": [
        { "stellarAddress": "GABC…", "outcome": "yes", "amount": "100" },
        { "stellarAddress": "GXYZ…", "outcome": "no",  "amount": "50"  }
      ],
      "totalAmount": "150"
    },
    "onChainSnapshot": {
      "positions": [
        { "stellarAddress": "GABC…", "outcome": "yes", "amount": "100" },
        { "stellarAddress": "GXYZ…", "outcome": "no",  "amount": "50"  }
      ],
      "totalAmount": "150",
      "available": true,
      "source": "soroban-rpc",
      "unavailableReason": null
    },
    "summary": {
      "totalKeys": 2,
      "matches": 2,
      "mismatches": 0,
      "missingOnChain": 0,
      "missingInDb": 0
    },
    "diffs": [
      {
        "key": { "stellarAddress": "GABC…", "outcome": "yes" },
        "dbAmount": "100",
        "onChainAmount": "100",
        "difference": "0",
        "status": "match"
      },
      {
        "key": { "stellarAddress": "GXYZ…", "outcome": "no" },
        "dbAmount": "50",
        "onChainAmount": "50",
        "difference": "0",
        "status": "match"
      }
    ]
  }
}
```

### Partial response (on-chain adapter not configured)

When the deployment does not yet have a live on-chain adapter wired in, the
endpoint returns `status: "partial"`:

```json
{
  "data": {
    "status": "partial",
    "onChainSnapshot": {
      "positions": [],
      "totalAmount": "0",
      "available": false,
      "source": "soroban-rpc",
      "unavailableReason": "On-chain market position lookup is not configured for this deployment yet."
    },
    "summary": {
      "totalKeys": 2,
      "matches": 0,
      "mismatches": 0,
      "missingOnChain": 2,
      "missingInDb": 0
    }
  }
}
```

All DB positions appear as `missing_on_chain` diffs. This is expected until the
Soroban contract read adapter is connected.

---

## Diff semantics

Each diff entry is keyed by `(stellarAddress, outcome)`. Positions are
aggregated by that composite key before comparison so duplicate rows are
collapsed correctly.

| `status`           | Meaning                                                 |
|--------------------|---------------------------------------------------------|
| `match`            | Amounts identical on both sides. No action required.    |
| `mismatch`         | Both sides have the key but amounts differ. Investigate.|
| `missing_on_chain` | Present in DB only. May indicate an indexing lead.      |
| `missing_in_db`    | Present on-chain only. May indicate a missed event.     |

The `difference` field for `mismatch` entries is `dbAmount − onChainAmount`.
A positive value means the DB holds more than the contract; negative means the
contract holds more.

---

## Interpreting results

**`summary.mismatches > 0`**

The DB and the contract disagree on at least one position amount. Check the
`diffs` array for the affected `(stellarAddress, outcome)` pairs. Cross-
reference the audit log and indexer events to find the discrepant transaction.

**`summary.missingOnChain > 0` (with `status: "ok"`)**

Predictions are recorded in the DB but not yet visible on-chain. This may be
normal during settlement lag. If the gap persists, run the reindex endpoint:

```bash
POST /api/admin/reindex  { "ledger": <start_ledger> }
```

**`summary.missingInDb > 0`**

On-chain positions have no matching DB record. This typically indicates a missed
Soroban event. Use the gap-scan worker to detect and backfill:

```bash
npm run indexer:gap-scan
```

**`status: "partial"`**

On-chain data was unavailable. Results reflect DB state only and every DB
position will appear as `missing_on_chain`. Wire the Soroban contract read
adapter before relying on reconciliation for live balance verification.

---

## Failure modes

| HTTP status | `error.code`       | Cause                                      |
|-------------|--------------------|--------------------------------------------|
| `400`       | `validation_error` | Market ID path param is blank or too long. |
| `403`       | `forbidden`        | Missing, expired, or non-admin JWT.        |
| `404`       | `not_found`        | No market with that ID exists in the DB.   |
| `500`       | `internal_error`   | Unexpected backend failure.                |

---

## Operational notes

- The endpoint is scoped to **one market per call** so results are fast and
  easy to reason about.
- DB rows are aggregated by `(stellarAddress, outcome)` before diffing.
  Duplicate confirmed predictions are summed, not double-counted.
- The call is idempotent and produces no side effects beyond the audit log row.
- Use the `summary` counters to triage at a glance, then drill into `diffs`
  for individual position details.
- For bulk or scheduled reconciliation, enqueue a `market` job on the
  `reconciliation` BullMQ queue (see `src/workers/reconciliationWorker.ts`).

---

## Related resources

- `src/routes/admin/reconciliation.ts` — HTTP handler
- `src/services/reconciliationService.ts` — diff logic and audit
- `src/workers/reconciliationWorker.ts` — async BullMQ worker
- `docs/job-queue.md` — queue design and enqueue patterns
- `POST /api/admin/reindex` — trigger a ledger backfill
- `GET /api/admin/health/detail` — check indexer lag before reconciling
