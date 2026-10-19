# Predictions Listing API

## `GET /api/predictions`

Returns a cursor-paginated list of predictions belonging to the **authenticated user**.

---

### Authentication

Requires a valid JWT in the `Authorization: Bearer <token>` header.
Returns `401 unauthenticated` when the token is absent, expired, or invalid.

The authenticated predictions listing endpoint is also protected by a per-user rate limit of `60` requests per minute. Once that quota is exceeded, the endpoint returns `429 rate_limit_exceeded` with `Retry-After` and `resetAt` metadata.

---

### Query Parameters

| Parameter  | Type   | Required | Default | Constraints       | Description                                                   |
|------------|--------|----------|---------|-------------------|---------------------------------------------------------------|
| `limit`    | number | no       | `20`    | 1–100             | Number of rows to return per page.                            |
| `cursor`   | string | no       | —       | opaque token      | Cursor from the previous page's `nextCursor`. Absent = page 1.|
| `marketId` | string | no       | —       | 1–128 chars       | Filter to a specific market.                                  |
| `status`   | string | no       | —       | enum (see below)  | Filter by prediction lifecycle status.                        |
| `outcome`  | string | no       | —       | 1–64 chars        | Filter by chosen outcome (e.g. `"yes"` / `"no"`).            |

**Status enum values:** `pending` · `confirmed` · `won` · `lost` · `claimed`

---

### Pagination

This endpoint uses **keyset (cursor) pagination** on `(createdAt DESC, id DESC)`.

- Pass the returned `nextCursor` verbatim as `?cursor=` to fetch the next page.
- `nextCursor` is `null` on the last page.
- Cursors are versioned. A stale or tampered cursor is safely ignored (the
  response restarts from page 1) rather than causing a 500 or a wrong offset.

```
GET /api/predictions?limit=20

{
  "data": [ ... ],
  "nextCursor": "djF8MjR8..."
}

GET /api/predictions?limit=20&cursor=djF8MjR8...

{
  "data": [ ... ],
  "nextCursor": null     ← last page
}
```

---

### Response Shape

**200 OK**

```json
{
  "data": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "marketId": "market-abc",
      "question": "Will ETH reach $10k by end of 2026?",
      "outcome": "yes",
      "amount": "100",
      "txHash": "abc123...",
      "status": "pending",
      "result": null,
      "createdAt": "2026-06-27T12:00:00.000Z",
      "resolutionTime": "2027-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "djF8MjR8..."
}
```

**400 validation_error** — invalid query parameters

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid enum value. Expected 'pending' | 'confirmed' | ...",
    "requestId": "req-uuid"
  }
}
```

**401 unauthenticated** — missing or invalid JWT

```json
{
  "error": { "code": "unauthenticated" }
}
```

**429 rate_limit_exceeded** — per-user quota exceeded

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests",
    "retryAfter": 60,
    "resetAt": "2026-07-25T12:34:56.000Z"
  }
}
```

---

### Implementation Details

#### Repository (`src/repositories/predictionRepo.ts`)

- Executes a single `SELECT … INNER JOIN markets … WHERE … ORDER BY createdAt DESC, id DESC LIMIT limit+1` query.
- The `limit + 1` probe determines whether a next page exists without a separate `COUNT(*)` round-trip.
- All filter conditions (`userId`, `marketId`, `status`, `outcome`) are injected as parameterised Drizzle column expressions — no string interpolation, so SQL injection is structurally impossible.
- The cursor keyset predicate is:
  ```sql
  (createdAt < cursorTime)
  OR (createdAt = cursorTime AND id < cursorId)
  ```
  This is the standard two-column keyset predicate for `DESC (createdAt, id)` ordering.

#### Route (`src/routes/predictions.ts`)

- Input validated with Zod at the route boundary before any DB access.
- `requireAuth` middleware enforces authentication; `req.user.id` is always populated when the handler executes.
- A per-user `createPerUserRateLimiter` protects the authenticated predictions routes at `60` requests/minute per user, returning a standard `429` error envelope with retry metadata.
- Structured logging via `pino` with `reqId` (from `x-request-id`) and `userId` on every log entry.
- Errors bubble to the global `errorHandler` middleware for standardised envelopes.

#### Cursor Encoding (`src/utils/cursor.ts`)

Cursors are versioned base64url tokens encoding `{ sortValue: ISO-string, id: UUID }`.
Version mismatches (e.g. after a schema migration) cause the cursor to be silently
discarded rather than mis-paginating.

---

### Differences from `GET /api/users/:address/predictions`

| Feature               | `/api/predictions`              | `/api/users/:address/predictions` |
|-----------------------|---------------------------------|-----------------------------------|
| Auth                  | Required (caller's own data)    | None (public, by Stellar address) |
| Scope                 | Authenticated user only         | Any Stellar address               |
| Filters               | marketId, status, outcome       | status only                       |
| Data source           | `predictionRepo.listPredictions`| `userService.getUserPredictions`  |

---

# Claiming winnings (user-signed)

`claim_winnings(user, market_id, claim_nonce)` on the Predictify contract calls
`user.require_auth()`, so **only the user's wallet can authorise a claim**. The
backend therefore never signs and never submits a claim on its own. A claim is a
two-step prepare / sign / submit flow.

## Sequence

```
Wallet / client                      Backend                          Soroban RPC
      |                                 |                                  |
      |-- POST /claim/prepare --------->|                                  |
      |   { marketId }                  |-- getAccount(user) ------------->|
      |                                 |-- simulate claim_winnings ------>|
      |                                 |   (user = source account)        |
      |<-- { claimId, xdr, passphrase,  |   store claims row "prepared"    |
      |      expiresAt } ---------------|   (expected tx hash, nonce, ttl) |
      |                                 |                                  |
      |  user signs xdr in the wallet   |                                  |
      |                                 |                                  |
      |-- POST /claim ----------------->|                                  |
      |   { claimId, signedXdr }        |  verify: source, contract,       |
      |                                 |  function, args, inner tx hash   |
      |                                 |  prepared -> submitting (atomic) |
      |                                 |-- sendTransaction -------------->|
      |<-- 200 { claimId, status:paid,  |<-- PENDING / DUPLICATE ----------|
      |          claimTxHash, ... } ----|  submitting -> paid              |
      |                                 |                                  |
      |             settle-confirmer finalises `paid` rows (settled / rejected)
```

## `POST /api/predictions/claim/prepare`

Request: `{ "marketId": "mkt_5cae97f9_0" }`. `marketId` must be a valid Soroban
`Symbol`: 1–32 characters of `[A-Za-z0-9_]`.

Response `200`:

```json
{
  "data": {
    "claimId": "0b7a5d5e-3c1f-4e0a-9d51-6d9f9a1c2b11",
    "xdr": "AAAAAgAAAA...",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "expiresAt": "2026-10-19T12:05:00.000Z"
  }
}
```

The transaction is `claim_winnings(user: Address, market_id: Symbol,
claim_nonce: u64)` with the **user's** account as source, already simulated and
assembled (fee and Soroban footprint set). It is valid for 5 minutes.

`claim_nonce` is `0` for a first claim and goes up by one for each later claim.
The backend simulates `get_claim_nonce` when the contract exports it (the slim
testnet build does not). If it does not, `0` is used only when the user has no
earlier paid or settled claim for the market; otherwise the call fails with
`claim_nonce_unavailable`.

Calling prepare again while a claim is outstanding returns the **same** claim
(same `claimId` and `xdr`) while it is still valid. At most one non-terminal
claim (`prepared`, `submitting` or `paid`) exists per user and market.

## `POST /api/predictions/claim`

Request: `{ "claimId": "<uuid>", "signedXdr": "<base64>" }`. `signedXdr` is
base64 and at most 16 KB.

Response `200`:

```json
{
  "data": {
    "claimId": "0b7a5d5e-3c1f-4e0a-9d51-6d9f9a1c2b11",
    "status": "paid",
    "predictionId": "11111111-1111-1111-1111-111111111111",
    "result": "won",
    "claimTxHash": "9f2c…",
    "claimedAt": "2026-10-19T12:00:03.000Z"
  }
}
```

### Why the transaction hash is the authority

A wallet signature does not change a transaction's hash. The backend stores the
hash of the transaction it simulated and accepts a signed envelope only when its
inner transaction hash is identical, which proves the envelope is exactly the
prepared transaction: same source, contract, function, arguments, fee,
footprint and time bounds. Before comparing hashes the backend also checks the
source account (must be the caller), contract id, function name and each
argument individually. Those checks exist to return a clear error code, not to
replace the hash check. A fee-bump wrapper is accepted if its inner transaction
passes.

## Claim states

| Status       | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `prepared`   | Unsigned transaction issued; waiting for the signed XDR.                |
| `submitting` | One request owns the claim and is calling `sendTransaction`.            |
| `paid`       | RPC returned `PENDING` or `DUPLICATE`; `settlement_tx` is set.          |
| `failed`     | RPC returned `ERROR`; `error_code` holds the mapped code.               |
| `expired`    | Not submitted before `expiresAt`.                                       |
| `settled` / `rejected` | Final result written by the settle-confirmer for `paid` rows. |

`prepared → submitting` is a conditional `UPDATE … WHERE status = 'prepared'`,
so concurrent submits of one claim reach the RPC exactly once; the others get
the stored result or `409 claim_in_progress`. If `sendTransaction` throws or
answers `TRY_AGAIN_LATER`, the claim returns to `prepared` and the response is
`503 claim_rpc_unavailable` — re-submitting the same signed transaction is safe.

## Idempotency

- Replaying a submit for a `paid` (or `settled`) claim returns `200` with the
  stored result and the same `claimTxHash`.
- Submitting a `failed` or `expired` claim returns `409`. Call prepare again to
  get a new claim.
- These rules hold independently of the global `Idempotency-Key` middleware.

## Error codes

Responses carry only these stable codes and fixed messages. Raw RPC and SDK
errors are written to structured logs (with the request correlation id) and are
never returned.

| Code                      | Status | Endpoint | Meaning                                                              |
|---------------------------|--------|----------|----------------------------------------------------------------------|
| `validation_error`        | 400    | both     | Bad body (`marketId` not a Symbol, `signedXdr` not base64 / over 16 KB, …). |
| `market_not_found`        | 404    | prepare  | No such market.                                                      |
| `market_not_resolved`     | 400    | prepare  | Market is not `resolved`.                                            |
| `prediction_not_found`    | 404    | prepare  | The caller has no prediction in the market.                          |
| `prediction_not_winning`  | 400    | prepare  | The prediction did not win.                                          |
| `claim_already_submitted` | 409    | prepare  | Winnings were already claimed (a `paid` / `settled` claim exists).   |
| `claim_in_progress`       | 409    | both     | A claim for this market is being submitted.                          |
| `claim_nonce_unavailable` | 409    | prepare  | `claim_nonce` cannot be determined for a repeat claim.               |
| `claim_simulation_failed` | 422    | prepare  | The RPC rejected the simulation.                                     |
| `claim_not_found`         | 404    | submit   | Unknown `claimId`, or it belongs to another user.                    |
| `claim_xdr_mismatch`      | 400    | submit   | The signed XDR is unsigned, malformed, or not the prepared claim. The RPC is not called. |
| `claim_expired`           | 409    | submit   | Submitted after `expiresAt` (or the network reported `txTooLate`).   |
| `claim_rejected`          | 422 / 409 | submit | The network rejected the transaction (409 on replay of a failed claim). |
| `claim_rpc_unavailable`   | 503    | submit   | The RPC could not be reached; the claim remains submittable.         |

## Metrics

- `claims_prepared_total` — unsigned claims prepared.
- `claims_submitted_total{outcome}` — submit attempts by outcome: `paid`,
  `failed`, `expired`, `mismatch`, `error`.
