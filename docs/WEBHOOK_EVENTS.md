# Webhook event catalog

Predictify sends signed HTTP `POST` requests to active webhook subscriptions
whose `events` list contains the emitted event type or the wildcard `*`.

Every delivery uses:

| Header | Description |
| --- | --- |
| `Content-Type: application/json` | Payload is JSON. |
| `X-Predictify-Signature` | `sha256=<hex>` HMAC-SHA256 signature over the raw request body. |
| `X-Predictify-Event` | Event type, for example `market.resolved`. |
| `X-Predictify-Delivery` | Unique delivery identifier for idempotency and retry tracking. |

## `market.resolved`

Emitted after an on-chain market resolution is applied to the off-chain market
row and predictions are marked won or lost.

Producer: `src/services/marketResolutionService.ts`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | string | yes | Always `market.resolved`. |
| `marketId` | string | yes | Predictify market identifier that was resolved. |
| `winningOutcome` | string | yes | Outcome value selected by the resolver and used to settle predictions. |
| `ledger` | integer | yes | Stellar ledger sequence where the resolution event was observed. |
| `timestamp` | integer | yes | Unix timestamp, in seconds, for the observed resolution event. |

Example:

```json
{
  "event": "market.resolved",
  "marketId": "market_01J4YC8Z7R8P9N0ABCDEF12345",
  "winningOutcome": "YES",
  "ledger": 521034,
  "timestamp": 1767225600
}
```

## `dispute.opened`

Emitted when an eligible user opens a dispute against a market outcome and the
market enters disputed status.

Producer: `src/services/disputeService.ts`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | yes | Always `dispute.opened`. |
| `marketId` | string | yes | Market identifier associated with the dispute. |
| `disputeId` | string | yes | Identifier of the created dispute record. |
| `openedBy` | string | yes | User identifier that opened the dispute. |
| `reason` | string | yes | User-provided dispute reason. |
| `evidenceUri` | nullable string | no | Optional URI containing evidence supplied by the disputing user. |
| `timestamp` | ISO-8601 string | yes | Timestamp for when the dispute was created. |

Example:

```json
{
  "type": "dispute.opened",
  "marketId": "market_01J4YC8Z7R8P9N0ABCDEF12345",
  "disputeId": "disc_01J4YF9TP2R0E3XYZ987654321",
  "openedBy": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "Oracle data did not match the published resolution source.",
  "evidenceUri": "https://example.com/evidence/market_01J4YC8",
  "timestamp": "2026-06-28T00:00:00.000Z"
}
```

## Subscription behavior

- A subscription receives an event when its `events` JSON array includes the
  exact event type.
- A subscription with `events: ["*"]` receives every event type.
- Failed deliveries follow the retry and dead-letter behavior documented in
  `docs/webhooks-dlq.md`.
