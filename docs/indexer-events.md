# Indexer events

The indexer (`src/services/indexerService.ts`) reads contract events for
`PREDICTIFY_CONTRACT_ID` from the Soroban RPC and stores one row per event in
`indexer_events`. `src/indexer/eventDecoder.ts` turns each raw event (topic
`ScVal`s plus the payload `ScVal`) into a typed, validated record before it is
stored.

Source of truth for symbols and layouts: `contracts/predictify-hybrid/src/events.rs`
in `Predictify-org/predictify-contracts` (commit `78ce97e`). Line numbers below
refer to that commit.

## Topics

| Symbol (`topic[0]`) | Topic layout | Payload fields (`events.rs` struct) | Backend table fed | `events.rs` |
|---|---|---|---|---|
| `mkt_crt` | `(mkt_crt, market_id: Symbol)` | `MarketCreatedEvent { market_id, question: String, outcomes: Vec<String>, admin: Address, end_time: u64, nonce: u64, timestamp: u64 }` | `indexer_events` | 2518 |
| `bet_plc` | `(bet_plc, market_id: Symbol)` | `BetPlacedEvent { market_id, bettor: Address, outcome: String, amount: i128, nonce: u64, timestamp: u64 }` | `indexer_events`; read by `predictionsConfirmer` to confirm `predictions` | 2667 |
| `bet_upd` | `(bet_upd, market_id: Symbol)` | `BetStatusUpdatedEvent { market_id, bettor: Address, old_status: String, new_status: String, payout_amount: Option<i128>, nonce: u64, timestamp: u64 }` | `indexer_events` | 2717 |
| `mkt_res` | `(mkt_res, market_id: Symbol, resolution_method: String)` | `MarketResolvedEvent { market_id, final_outcome: String, oracle_result: String, community_consensus: String, resolution_method: String, confidence_score: i128, nonce: u64, timestamp: u64 }` | `indexer_events` | 3022 |
| `win_clm` | `(win_clm, market_id: Symbol)` | `WinningsClaimedEvent { market_id, user: Address, amount: i128, nonce: u64, timestamp: u64 }` | `indexer_events` | 3946 |

Projecting decoded events into `markets` and `predictions` (beyond the
confirmer join) is out of scope; the five topics above feed `indexer_events`
only.

### Aliases

`event_topic_catalog.rs` lists long names that differ from the symbols
`events.rs` publishes. The decoder accepts them as aliases and stores the
emitted symbol:

| Catalog name | Stored as |
|---|---|
| `market_created` | `mkt_crt` |
| `bet_placed` | `bet_plc` |
| `market_resolved` | `mkt_res` |
| `winnings_claimed` | `win_clm` |

`bet_upd` has no catalog alias.

### Anything else

Every other topic the contract publishes (for example `vote`, `fbk_used`,
`stats_upd`) is stored with `event_type = 'unknown:<symbol>'`. A new topic added
on-chain therefore needs no code change to be indexed. Batch claim events are
not decoded.

## Stored row

| Column | Value |
|---|---|
| `event_type` | the topic symbol (`bet_plc`), `unknown:<symbol>`, or `invalid:<symbol>` |
| `market_id` | `topic[1]` for market-scoped events, otherwise `NULL` |
| `data` | JSON object, see below |

- **Decoded** (`event_type` is a topic symbol): `data` holds the payload fields
  in camelCase (`bettor`, `outcome`, `amount`, `nonce`, `timestamp`, ...).
  `market_id` is the column, not repeated in `data`.
- **Unknown** (`unknown:<symbol>`): `data = { "raw": { "topics": [<base64 XDR>...], "value": <base64 XDR> } }`.
- **Invalid** (`invalid:<symbol>`): a known topic whose layout or payload failed
  validation. `data = { "raw": {...}, "errors": [<message>...] }`. Validation
  covers missing or mistyped fields, an address that is not a `G...`/`C...`
  strkey, `topic[1]` or `topic[2]` disagreeing with the payload, and
  out-of-range integers. `invalid:topic` is used when `topic[0]` is absent, is
  not a `Symbol`, or the XDR cannot be parsed.

Unknown and invalid events are never dropped and never throw out of a batch.
Events whose RPC `type` is not `contract`, or that come from another contract,
are filtered out before persistence.

### Numbers

All 64- and 128-bit integers (`amount`, `payout_amount`, `confidence_score`,
`nonce`, `timestamp`, `end_time`) are decimal strings. No floating point is used,
so `i128::MAX` round-trips as `170141183460469231731687303715884105727`.
`payout_amount` is `null` when the contract emitted `None`.

## Confirmer join

`predictionsConfirmer` confirms a pending prediction only when `indexer_events`
has a row with all of:

- the same `tx_hash` as the prediction,
- `event_type = 'bet_plc'` and `canonical = true`,
- `market_id` equal to the prediction's market,
- `data->>'bettor'` equal to the prediction user's `stellar_address`.

An `unknown:*`, `invalid:*` or other-topic event in the same transaction does not
confirm anything, and does not stop the prediction from aging out to `failed`.

## Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `indexer_events_decoded_total` | `event_type` | Events decoded, by topic symbol. Unknown topics are grouped under `unknown` to keep label cardinality bounded. |
| `indexer_events_invalid_total` | `event_type` | Events that failed validation, by topic symbol (`topic` for an unreadable `topic[0]`). |

## Testnet configuration

```bash
export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
export PREDICTIFY_CONTRACT_ID=CCWRJXIUBSMFQ4AF2RXXH3AFBW6MEZG4GK4IYES7C4Z3X4PR6K7VAFHC
npm run indexer:dev
```

Both are commented in `.env.example`.

## Cross-check against `events.rs`

```bash
grep -n 'symbol_short!("\(mkt_crt\|bet_plc\|bet_upd\|mkt_res\|win_clm\)")' events.rs | grep -v nonce
```

```
2516:        Self::store_event(env, &symbol_short!("mkt_crt"), &event);
2518:            .publish((symbol_short!("mkt_crt"), market_id.clone()), event);
2665:        Self::store_event(env, &symbol_short!("bet_plc"), &event);
2667:            .publish((symbol_short!("bet_plc"), market_id.clone()), event);
2715:        Self::store_event(env, &symbol_short!("bet_upd"), &event);
2717:            .publish((symbol_short!("bet_upd"), market_id.clone()), event);
3019:        env.storage().persistent().set(&symbol_short!("mkt_res"), &event);
3022:                symbol_short!("mkt_res"),
3944:        Self::store_event(env, &symbol_short!("win_clm"), &event);
3946:            .publish((symbol_short!("win_clm"), market_id.clone()), event);
```
