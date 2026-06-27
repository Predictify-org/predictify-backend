# Reconciliation runbook

## Purpose

Use the admin reconciliation endpoint to inspect a single market and compare the
backend's database snapshot with the available on-chain snapshot.

## Endpoint

`GET /api/admin/recon/markets/:id`

### Security

- Admin-only route guarded by the existing bearer JWT admin middleware.
- Every successful inspection is audit logged as
  `admin.reconciliation.market.inspect`.
- Correlate the request with the `x-request-id` response header and the
  `correlationId` field in the JSON payload.

### Request

```bash
curl --request GET \
  --url http://localhost:3000/api/admin/recon/markets/MARKET_ID \
  --header 'Authorization: Bearer <admin-jwt>' \
  --header 'X-Request-Id: recon-market-123'
```

### Success response

```json
{
  "data": {
    "marketId": "MARKET_ID",
    "correlationId": "recon-market-123",
    "generatedAt": "2026-06-27T12:00:00.000Z",
    "status": "ok",
    "dbSnapshot": {
      "positions": [
        {
          "stellarAddress": "G...USER",
          "outcome": "yes",
          "amount": "100"
        }
      ],
      "totalAmount": "100"
    },
    "onChainSnapshot": {
      "positions": [
        {
          "stellarAddress": "G...USER",
          "outcome": "yes",
          "amount": "100"
        }
      ],
      "totalAmount": "100",
      "available": true,
      "source": "soroban-rpc",
      "unavailableReason": null
    },
    "summary": {
      "totalKeys": 1,
      "matches": 1,
      "mismatches": 0,
      "missingOnChain": 0,
      "missingInDb": 0
    },
    "diffs": [
      {
        "key": {
          "stellarAddress": "G...USER",
          "outcome": "yes"
        },
        "dbAmount": "100",
        "onChainAmount": "100",
        "difference": "0",
        "status": "match"
      }
    ]
  }
}
```

## Diff semantics

Each diff entry is keyed by `(stellarAddress, outcome)`.

- `match`: amounts are identical.
- `mismatch`: amounts exist on both sides but differ.
- `missing_on_chain`: present in DB only.
- `missing_in_db`: present on-chain only.

## Operational notes

- The route is intentionally scoped to one market so results are fast to review.
- DB rows are aggregated by `(stellarAddress, outcome)` before comparison.
- If the deployment does not yet have a live on-chain position adapter wired in,
  the endpoint returns `status: "partial"` and `onChainSnapshot.available: false`
  with an explanatory `unavailableReason`.
- Use the `summary` counters first, then inspect individual `diffs`.

## Failure modes

- `400 validation_error`: invalid market id path param.
- `403 forbidden`: missing or non-admin bearer token.
- `404 not_found`: no such market.
- `500 internal_error`: unexpected backend failure.
