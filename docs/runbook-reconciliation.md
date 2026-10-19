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

## Claims & Payout Reconciliation (Automated & On-Demand)

### Purpose & Architecture

The Claims & Payout Reconciliation engine periodically compares on-chain claim events emitted by the Soroban prediction market contracts against database payout and prediction records. Unlike the single-market position diff tool, payout reconciliation inspects settlement distributions across time windows and reports persisted, auditable reports.

When discrepancies are detected, the system:
1. Records a fingerprint-hashed reconciliation report in `reconciliation_reports` with status `discrepancies_found`.
2. Persists granular discrepancy rows in `reconciliation_discrepancies`.
3. Increments Prometheus metrics `reconciliation_discrepancies_total{kind="<kind>"}`.
4. Emits structured audit log entries (`reconciliation.payouts.completed`) with severity metadata for incident alerting.

---

### Discrepancy Kinds & Severities

| Kind | Severity | Description | Immediate Impact |
|---|---|---|---|
| `claimed_on_chain_missing_in_db` | **CRITICAL** | A claim was settled on-chain via Soroban event, but no corresponding payout record exists in the backend DB. | Indexer lag, missed webhook, or untracked contract interaction. |
| `db_paid_missing_on_chain` | **CRITICAL** | DB marks payout as paid/settled, but no matching on-chain event exists within the reconciliation window. | Potential phantom credit, failed transaction that was marked paid, or RPC desync. |
| `amount_mismatch` | **CRITICAL** | On-chain claim amount differs from DB payout amount for the same claim identifier / user prediction. | Calculation error, rounding bug, or unexpected smart contract fee deduction. |
| `claim_for_losing_prediction` | **CRITICAL** | On-chain claim event references a prediction row whose resolved outcome does not match the winning outcome. | Contract logic bug, market resolution dispute divergence, or unauthorized drain attempt. |
| `duplicate_on_chain_claim` | **CRITICAL** | Multiple on-chain claim events detected for the same unique prediction ID. | Smart contract replay bug or missing contract-level payout check. |
| `stale_unclaimed` | **MEDIUM / INFO** | DB prediction is marked eligible for winning claim, but has remained unclaimed beyond the configured grace period (e.g. 7+ days). | User did not claim tokens yet, or claiming UI has issues. Low operational risk, no fund loss. |

---

### Time Windows & Lookback Parameters

Reconciliation runs against parameterized time boundaries:
- `windowStart`: Beginning of the evaluation period (ISO timestamp or Date).
- `windowEnd`: End of the evaluation period (defaults to execution timestamp).
- `settlementGracePeriodMs`: Configurable buffer (default 1 hour) to allow in-flight transactions and indexer ingestion to settle before flagging a missing DB row or missing on-chain claim.

---

### Querying Reports via Admin API

Operators can inspect reconciliation reports and their granular discrepancies using the Admin API:

#### 1. List Reconciliation Reports
```bash
curl --request GET \
  --url "https://<host>/api/admin/reports?limit=20&status=discrepancies_found" \
  --header 'Authorization: Bearer <admin-jwt>'
```
- Requires permission scope: `report:read` (or `role: "admin"`).
- Supports keyset pagination using `cursor` and `limit`.
- Response includes `id`, `windowStart`, `windowEnd`, `status`, `discrepancyCount`, `fingerprint`, and `createdAt`.

#### 2. Get Detailed Reconciliation Report
```bash
curl --request GET \
  --url "https://<host>/api/admin/reports/<REPORT_ID>" \
  --header 'Authorization: Bearer <admin-jwt>'
```
- Returns the complete report along with the `discrepancies` array containing:
  - `kind`: One of the 6 discrepancy types
  - `marketId`: Target prediction market
  - `predictionId`: Affected prediction ID (if resolved)
  - `claimantAddress`: Stellar account address
  - `onChainAmount` & `dbAmount`: Exact Stroop-level amounts
  - `severity`: `"critical"` | `"medium"` | `"info"`
  - `details`: JSON object with execution context and transaction hashes

---

### Operator Triage & Remediation Runbook

When a critical discrepancy alert is raised (`reconciliation_discrepancies_total > 0`):

#### Scenario A: `claimed_on_chain_missing_in_db`
1. Fetch report details: `GET /api/admin/reports/:id`.
2. Extract the transaction hash and claimant address from `details`.
3. Check indexer health probe: `GET /api/admin/health/detail` to verify if the Soroban indexer is lagging.
4. If indexer is lagging, run gap backfill:
   ```bash
   POST /api/admin/reindex { "ledger": <start_ledger> }
   ```
5. If indexer is healthy, verify whether the event was skipped due to malformed payload in the dead-letter queue:
   ```bash
   GET /api/admin/webhooks/dlq
   ```

#### Scenario B: `db_paid_missing_on_chain`
1. Query the payout transaction hash in Stellar Horizon / Soroban RPC.
2. If the transaction failed on-chain or never submitted:
   - Check the outbox queue (`docs/side-effect-outbox.md`).
   - Revert DB status from `paid` to `pending` or re-queue the payout worker job.
3. If transaction succeeded on-chain but was outside the reconciliation time window, adjust `windowStart` or increase `settlementGracePeriodMs`.

#### Scenario C: `amount_mismatch`
1. Compare `onChainAmount` vs `dbAmount` in the discrepancy details.
2. Note: Amounts are stored as exact 7-decimal Stroop values (e.g. `10000000` = `1.0000000 XLM`).
3. If fees or pool split caused deviation, verify contract formula against `payoutCalculationService.ts`.
4. If DB over-credited, freeze account payout withdrawals and conduct ledger balance review.

#### Scenario D: `claim_for_losing_prediction`
1. **HALT TRADING & PAYOUTS**: Immediately inspect market resolution status.
2. Verify Soroban contract state using `soroban contract invoke` for the affected `marketId`.
3. Audit oracle resolution events (`docs/ORACLE_SETTLEMENT_GUARD.md`) to verify if an erroneous resolution was executed on-chain.

#### Scenario E: `duplicate_on_chain_claim`
1. Inspect both claim transactions on Horizon to check if the contract allowed a double payout.
2. If verified duplicate, engage security escalation protocol immediately to pause contract withdrawals.

---

## Related resources

- `src/routes/admin/reconciliation.ts` — Admin reconciliation HTTP endpoints (`GET /api/admin/reports`, `GET /reports/:id`)
- `src/services/reconciliationService.ts` — Diff engine, payout rules, and report persistence
- `src/workers/reconciliationWorker.ts` — Scheduled BullMQ background worker
- `docs/job-queue.md` — BullMQ queue design and enqueue patterns
- `POST /api/admin/reindex` — Trigger Soroban ledger backfill
- `GET /api/admin/health/detail` — Check indexer lag before reconciling
