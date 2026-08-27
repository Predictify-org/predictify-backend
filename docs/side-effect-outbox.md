# Payout and notification outbox

Payouts and notifications have two different reliability boundaries: the
database transaction that records business state and the provider call that
delivers a side effect. The side-effect outbox joins those boundaries by
writing an outbox row in the same logical transaction as the business record.
The worker delivers the row later and records the result.

## Transaction boundary

Use `SideEffectOutbox.transaction()` for a state change that requires an
external payout or notification:

```ts
outbox.transaction((transaction) => {
  transaction.putSideEffect(`payout:${payoutId}`, {
    predictionId,
    amount,
  });
  transaction.enqueue(
    `payout:${payoutId}`,
    OUTBOX_EVENT_TYPES.PAYOUT,
    { predictionId, amount },
  );
});
```

The callback stages both the business-side effect and its delivery record.
Neither becomes visible if the callback throws. The transaction is deliberately
small and synchronous in the in-memory implementation; a database adapter can
put the equivalent inserts in one SQL transaction. Provider calls must never
run inside this commit callback.

This ordering addresses the crash window after commit and before delivery:

1. The business state and pending outbox event commit together.
2. The process crashes before the provider call.
3. A later worker claims the still-pending event.
4. The provider receives the event and the worker marks it complete.

There is no silent “database committed, queue publish failed” branch. A
duplicate idempotency key is a no-op and cannot create a second side effect.
The first payload remains authoritative, so a caller cannot rewrite a pending
event by repeating an enqueue with different data.

## Event types and keys

The current event catalog contains:

| Type | Key format | Example payload |
| ---- | ---------- | --------------- |
| `payout` | `payout:<payout-id>` | Prediction, amount, and currency |
| `notification` | `notification:<notification-id>` | User, title, body, and data |

Use stable business IDs for keys. A retry, worker restart, HTTP retry, or
replayed command must calculate the same key. `enqueuePayout` and
`enqueueNotification` are small helpers that enforce the catalog prefix.
Payloads are cloned at the transaction boundary and when returned from the
store, preventing later caller mutation from changing an audit or delivery
record.

## Worker lifecycle

The processor uses four states:

- `pending`: committed and waiting for delivery or its next retry;
- `processing`: claimed by a worker and protected by a lease;
- `completed`: the handler acknowledged the side effect;
- `dead_letter`: the handler failed at the maximum attempt count.

`claim(limit, now, leaseMs)` orders pending rows by creation time and stable
idempotency key,
marks at most the bounded limit as processing, increments their attempts, and
returns snapshots. A worker crash leaves the row processing only until the
lease expires. A later claim reclaims it as pending. The claim operation is
the point at which an attempt is counted, so an attempt that crashes before
the provider call is still visible to operators.

`process(handler, options, now)` claims a bounded batch and handles every
claimed row independently. A handler exception is converted into a safe error
string. The row returns to pending with exponential delay until its attempt
limit is reached; after that it becomes a terminal dead letter. Processing
continues to the next row after either outcome, so one poison notification
cannot starve an unrelated payout.

## Idempotency

The outbox deduplicates enqueue operations by `idempotencyKey`. It also avoids
calling a handler for completed rows because only pending rows can be claimed.
The downstream payout and notification handlers must still be idempotent: a
worker can crash after a provider accepts a request but before the completion
update. The handler should pass the outbox event ID or business key to a
provider that supports idempotency and should use a database uniqueness guard
for local effects.

Exactly-once execution is not promised by a networked worker. The design
provides at-least-once delivery plus stable keys and completion state, which is
the safe boundary for external effects.

## Retry and poison handling

The default maximum is five attempts. Backoff starts at 250 ms and is capped at
60 seconds. Configuration is bounded inside the service: attempts are capped
at 20, delays at 60 seconds, and a claim batch at 1,000 rows. Invalid negative,
zero, fractional, or non-finite values raise `OutboxError` with the stable
`INVALID_OPTIONS` code. The handler's internal exception text is retained only
as the operator-facing `lastError` field; it is not thrown through the worker
loop or returned as an HTTP response.

A poison event enters `dead_letter` after its final failed attempt. It remains
visible through `list("dead_letter")` for a separate repair or replay tool.
The worker never deletes poison rows automatically. Operators can correct a
bad recipient, fix a payload contract, or explicitly replay with the same
business key after investigation.

## Payout guidance

Payout state should be recorded in the same transaction as a `payout` event.
The payout handler should submit the event using a provider idempotency key,
persist any transaction hash, and treat an already-completed payout as a
successful no-op. It must not infer payment completion merely because an
outbox event was claimed. Chain confirmation remains a separate concern.

## Notification guidance

Notification rows and their `notification` outbox event should be committed
together when a user-visible state change requires a notification. Email,
push, and webhook adapters should be separate handlers or downstream fanout
steps. A malformed address or permanently rejected template should exhaust
only that event and leave other notifications eligible for delivery.

## Observability and operations

Expose counts by status and event type to metrics, and alert on pending age,
processing leases that expire repeatedly, and dead-letter growth. Include the
outbox event ID, idempotency key, business entity ID, attempt, and correlation
ID in structured logs. Do not include access tokens or provider credentials in
payloads or error strings.

The outbox is process-local in the development implementation. It is useful
for deterministic tests and local behavior, but a production deployment must
back it with durable database rows or a durable queue. The required properties
for that adapter are the same: unique idempotency key, atomic business-plus-
outbox commit, lease-based claiming, conditional completion, bounded retry,
and a terminal dead-letter state.

## Test matrix

The regression suite covers atomic commit, rollback on callback failure,
duplicate payout and notification requests, payload isolation, deterministic
claiming, successful processing, crash/lease recovery, transient retry,
terminal exhaustion, poison-message isolation, and invalid configuration.
Together these cases protect both the database-to-outbox crash boundary and
the outbox-to-provider delivery boundary without requiring a live provider.
