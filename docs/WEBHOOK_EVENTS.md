# Webhook Events Catalog

Reference for every webhook event type emitted by Predictify. Subscribers use
these event type strings when creating a subscription and can expect the
documented payload schema on every delivery.

> **Delivery mechanics.** Every POST carries the JSON payload in the body,
> signed with `X-Predictify-Signature: sha256=<hex>` (HMAC-SHA-256 over the raw
> body bytes using the subscription secret). A unique `X-Predictify-Delivery`
> UUID is included in each request so subscribers can detect and deduplicate
> retries. See [webhook delivery & DLQ](./webhooks-dlq.md) for retry schedules
> and dead-letter queue behaviour.
>
> **Catalog retrieval.** `GET /api/webhooks` now returns a strong `ETag` and
> supports conditional revalidation with `If-None-Match`; a matching request
> returns `304 Not Modified` without a body.

---

## Envelope fields

Every payload object contains the following top-level fields regardless of
event type.

| Field | Type | Description |
|---|---|---|
| `event` | `string` | Event type literal, e.g. `"market.resolved"`. |
| `id` | `string (UUID v4)` | Unique ID for this delivery attempt. Use to deduplicate retries. |
| `timestamp` | `string (ISO 8601 UTC)` | Server-side time at which the event was produced. |

---

## Subscription wildcards

When creating a subscription you may supply `"*"` in the `events` array to
receive every event type. The wildcard is a subscription filter — it is **not**
an event type string that appears in the `event` field of a payload.

---

## Event types

### `market.resolved`

**Trigger:** Emitted when the on-chain indexer detects that a prediction market
has been resolved and the winning outcome has been recorded on the Stellar
ledger.

**When to expect it:** Once per market, after the resolution ledger event is
indexed. The call is idempotent: replaying the same on-chain event does not
emit a second webhook.

**Payload schema**

```json
{
  "event": "market.resolved",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2025-11-15T09:00:00.000Z",
  "marketId": "mkt-abc123",
  "winningOutcome": "yes",
  "ledger": 5000000,
  "onChainTimestamp": 1731661200
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | `"market.resolved"` | ✓ | Literal event type. |
| `id` | `string (UUID)` | ✓ | Unique delivery ID. |
| `timestamp` | `string (ISO 8601)` | ✓ | Server time the event was produced. |
| `marketId` | `string` | ✓ | Primary key of the market in the `markets` table. |
| `winningOutcome` | `string` | ✓ | The outcome string that won. Matches `predictions.outcome` values. |
| `ledger` | `integer ≥ 0` | ✓ | Stellar ledger sequence of the on-chain resolution event. |
| `onChainTimestamp` | `integer ≥ 0` | ✓ | Unix timestamp (seconds) of the on-chain resolution event. |

**Example use cases**
- Update your UI to show the resolved outcome and final payouts.
- Trigger payout processing for winning predictions.
- Archive or close market-related records in your own database.

---

### `dispute.opened`

**Trigger:** Emitted when a user who holds a confirmed prediction in a market
files a dispute against that market's resolution. Opening a dispute transitions
the market to `"disputed"` status.

**When to expect it:** Each time a unique (user, market) pair successfully
opens a dispute. The service enforces that only one open dispute per user per
market can exist at a time (subsequent attempts return a `409 duplicate_dispute`
error and do not emit a webhook).

**Payload schema**

```json
{
  "event": "dispute.opened",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "timestamp": "2025-11-15T10:30:00.000Z",
  "marketId": "mkt-abc123",
  "disputeId": "d8e8fca2-dc0f-4b7c-b5e4-0a8a68f4c6f2",
  "openedBy": "b5bd03d0-1f48-4a23-b25c-2fb51c68fbd8",
  "reason": "The winning outcome does not match the source data.",
  "evidenceUri": "https://evidence.example.com/doc.pdf"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | `"dispute.opened"` | ✓ | Literal event type. |
| `id` | `string (UUID)` | ✓ | Unique delivery ID. |
| `timestamp` | `string (ISO 8601)` | ✓ | Server time the event was produced. |
| `marketId` | `string` | ✓ | Primary key of the disputed market. |
| `disputeId` | `string (UUID)` | ✓ | UUID of the newly created dispute row. |
| `openedBy` | `string (UUID)` | ✓ | UUID of the user who opened the dispute. |
| `reason` | `string` | ✓ | Free-text reason provided by the disputing user. Non-empty. |
| `evidenceUri` | `string (URL) \| null` | — | URI to supporting evidence, or `null` if none was supplied. |

**Example use cases**
- Notify internal review teams of new dispute submissions.
- Pause automated payout pipelines while a dispute is open.
- Record dispute events in a compliance audit trail.

---

## Subscribing to events

Use the webhook subscription API to register an endpoint. Pass an array of
event type strings in `events`; use `"*"` to receive all events.

```http
POST /api/webhooks/subscriptions
Content-Type: application/json

{
  "url": "https://your-service.example.com/hooks/predictify",
  "events": ["market.resolved", "dispute.opened"]
}
```

The response includes a one-time `secret` field (64-char hex). Store it
securely — you will need it to verify incoming signatures.

### Verifying signatures

```js
const crypto = require("crypto");

function verify(secret, rawBody, signatureHeader) {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

> **Important.** Compute the HMAC over the **raw request body bytes**, not a
> re-serialised version of the parsed JSON. Key order, whitespace, or encoding
> differences will produce a different digest and cause verification to fail.

---

## TypeScript types

The canonical types and Zod schemas live in
[`src/services/webhookCatalog.ts`](../src/services/webhookCatalog.ts).

```ts
import {
  buildPayload,
  validatePayload,
  isKnownEventType,
  ALL_EVENT_TYPES,
  type MarketResolvedPayload,
  type DisputeOpenedPayload,
  type WebhookEventType,
} from "./src/services/webhookCatalog";
```

### `buildPayload(eventType, data)` — dispatch sites

Stamps envelope fields (`id`, `timestamp`, `event`) automatically and validates
the combined object before returning it.

```ts
const payload = buildPayload("market.resolved", {
  marketId: "mkt-abc",
  winningOutcome: "yes",
  ledger: 5_000_000,
  onChainTimestamp: 1_731_661_200,
});
// typeof payload → MarketResolvedPayload (fully typed, envelope included)
```

### `validatePayload(eventType, unknown)` — inbound verification

Validates an untrusted object (e.g. deserialized from an inbound webhook call)
against the catalog schema. Throws `ZodError` on mismatch.

```ts
const payload = validatePayload("dispute.opened", req.body);
```

### `isKnownEventType(string)` — type guard

```ts
if (isKnownEventType(raw)) {
  // raw is narrowed to WebhookEventType
}
```

---

## Adding a new event type

1. Define a Zod schema in `src/services/webhookCatalog.ts` extending
   `WebhookEnvelopeSchema`:

   ```ts
   export const ClaimReadyPayloadSchema = WebhookEnvelopeSchema.extend({
     event: z.literal("claim.ready"),
     marketId: z.string(),
     userId: z.string().uuid(),
     claimId: z.string().uuid(),
     amount: z.string(),
   });
   export type ClaimReadyPayload = z.infer<typeof ClaimReadyPayloadSchema>;
   ```

2. Register it in `WEBHOOK_EVENT_SCHEMAS`:

   ```ts
   export const WEBHOOK_EVENT_SCHEMAS = {
     "market.resolved": MarketResolvedPayloadSchema,
     "dispute.opened":  DisputeOpenedPayloadSchema,
     "claim.ready":     ClaimReadyPayloadSchema,   // ← new
   } as const;
   ```

3. Add a section to this document following the template above.

4. Add tests in `tests/webhookCatalog.test.ts`.

`ALL_EVENT_TYPES`, `WebhookEventType`, and `WebhookPayload` update
automatically; no other code changes are required.
