/**
 * eventDecoder.ts
 *
 * Pure, deterministic decoder for events published by the Predictify contract
 * (`contracts/predictify-hybrid/src/events.rs` in predictify-contracts).
 *
 * The decoder reads `topic[0]` as the event symbol, `topic[1]` as the
 * `market_id` symbol where present, converts the payload with `scValToNative`
 * and validates it with one zod schema per topic. It performs no I/O and never
 * throws: anything it cannot understand comes back as an `unknown` or
 * `invalid` result carrying the raw base64 XDR.
 *
 * Number handling: every 64/128-bit integer (i128 amounts, u64 nonces and
 * timestamps) is emitted as a decimal string. No floating point is involved.
 */

import { scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";

// ─── Public types ────────────────────────────────────────────────────────────

/** Topic symbols published by the contract that this decoder understands. */
export const DECODED_TOPICS = [
  "mkt_crt",
  "bet_plc",
  "bet_upd",
  "mkt_res",
  "win_clm",
] as const;

export type DecodedTopic = (typeof DECODED_TOPICS)[number];

const DECODED_TOPIC_SET: ReadonlySet<string> = new Set(DECODED_TOPICS);

/**
 * `event_topic_catalog.rs` lists long names that differ from the symbols
 * `events.rs` actually emits. They are accepted as aliases of the emitted
 * symbol and normalised to it.
 */
export const TOPIC_ALIASES: Readonly<Record<string, DecodedTopic>> = {
  market_created: "mkt_crt",
  bet_placed: "bet_plc",
  market_resolved: "mkt_res",
  winnings_claimed: "win_clm",
};

const TOPIC_ALIAS_MAP: ReadonlyMap<string, DecodedTopic> = new Map(Object.entries(TOPIC_ALIASES));

/** A raw event: XDR `ScVal` objects or base64-encoded XDR strings. */
export interface RawContractEvent {
  topic: ReadonlyArray<xdr.ScVal | string>;
  value: xdr.ScVal | string;
}

export interface RawXdr {
  topics: string[];
  value: string;
}

export interface MarketCreatedFields {
  question: string;
  outcomes: string[];
  admin: string;
  endTime: string;
  nonce: string;
  timestamp: string;
}

export interface BetPlacedFields {
  bettor: string;
  outcome: string;
  amount: string;
  nonce: string;
  timestamp: string;
}

export interface BetUpdatedFields {
  bettor: string;
  oldStatus: string;
  newStatus: string;
  payoutAmount: string | null;
  nonce: string;
  timestamp: string;
}

export interface MarketResolvedFields {
  resolutionMethod: string;
  finalOutcome: string;
  oracleResult: string;
  communityConsensus: string;
  confidenceScore: string;
  nonce: string;
  timestamp: string;
}

export interface WinningsClaimedFields {
  user: string;
  amount: string;
  nonce: string;
  timestamp: string;
}

interface DecodedBase<T extends DecodedTopic> {
  status: "decoded";
  eventType: T;
  marketId: string;
}

export type DecodedEvent =
  | (DecodedBase<"mkt_crt"> & MarketCreatedFields)
  | (DecodedBase<"bet_plc"> & BetPlacedFields)
  | (DecodedBase<"bet_upd"> & BetUpdatedFields)
  | (DecodedBase<"mkt_res"> & MarketResolvedFields)
  | (DecodedBase<"win_clm"> & WinningsClaimedFields);

/** A topic the decoder does not know. Forward compatible: no code change needed. */
export interface UnknownEvent {
  status: "unknown";
  /** `unknown:<symbol>` */
  eventType: string;
  marketId: string | null;
  raw: RawXdr;
}

/** A known topic whose topic layout or payload failed validation. */
export interface InvalidEvent {
  status: "invalid";
  /** `invalid:<symbol>` */
  eventType: string;
  marketId: string | null;
  errors: string[];
  raw: RawXdr;
}

export type DecodeResult = DecodedEvent | UnknownEvent | InvalidEvent;

// ─── Validation primitives ───────────────────────────────────────────────────

const I128_MIN = -(BigInt(2) ** BigInt(127));
const I128_MAX = BigInt(2) ** BigInt(127) - BigInt(1);
const U64_MAX = BigInt(2) ** BigInt(64) - BigInt(1);
const ZERO = BigInt(0);

/**
 * Field checks run once per payload inside a single transform per schema.
 * (Per-field refine/transform wrappers made zod the dominant decode cost.)
 * Each helper reports through the zod context, so failures surface as normal
 * zod issues with the field path.
 */
function i128Of(value: bigint, path: string, ctx: z.RefinementCtx): string {
  if (value < I128_MIN || value > I128_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "out of i128 range" });
  }
  return value.toString();
}

function u64Of(value: bigint, path: string, ctx: z.RefinementCtx): string {
  if (value < ZERO || value > U64_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "out of u64 range" });
  }
  return value.toString();
}

/** `G…` account or `C…` contract strkey, checksum verified. */
function addressOf(value: string, path: string, ctx: z.RefinementCtx): string {
  if (!isValidAddress(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "not a valid G… or C… strkey" });
  }
  return value;
}

/**
 * Checksum results are memoised (bounded) because the same few addresses
 * repeat constantly; the memo only caches a pure function of the string, so
 * output is unchanged.
 */
const ADDRESS_MEMO_LIMIT = 4096;
const addressMemo = new Map<string, boolean>();
const strkeyMemo = new Map<string, string>();

/**
 * Encode raw address bytes as a strkey. The result is valid by construction,
 * so it is also recorded as a validated address; both memos are bounded.
 */
function strkeyOf(kind: "G" | "C", bytes: Buffer): string {
  const key = kind + bytes.toString("latin1");
  let encoded = strkeyMemo.get(key);
  if (encoded === undefined) {
    encoded = kind === "G" ? StrKey.encodeEd25519PublicKey(bytes) : StrKey.encodeContract(bytes);
    if (strkeyMemo.size >= ADDRESS_MEMO_LIMIT) strkeyMemo.clear();
    strkeyMemo.set(key, encoded);
    if (addressMemo.size >= ADDRESS_MEMO_LIMIT) addressMemo.clear();
    addressMemo.set(encoded, true);
  }
  return encoded;
}

function isValidAddress(value: string): boolean {
  const cached = addressMemo.get(value);
  if (cached !== undefined) return cached;
  const valid = StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
  if (addressMemo.size >= ADDRESS_MEMO_LIMIT) addressMemo.clear();
  addressMemo.set(value, valid);
  return valid;
}

const text = z.string();
const marketIdField = z.string().min(1);
const int = z.bigint();

// ─── Per-topic payload schemas (keys are the on-chain snake_case names) ──────

const marketCreatedSchema = z
  .object({
    market_id: marketIdField,
    question: text,
    outcomes: z.array(text),
    admin: text,
    end_time: int,
    nonce: int,
    timestamp: int,
  })
  .transform((p, ctx) => ({
    marketId: p.market_id,
    fields: {
      question: p.question,
      outcomes: p.outcomes,
      admin: addressOf(p.admin, "admin", ctx),
      endTime: u64Of(p.end_time, "end_time", ctx),
      nonce: u64Of(p.nonce, "nonce", ctx),
      timestamp: u64Of(p.timestamp, "timestamp", ctx),
    } satisfies MarketCreatedFields,
  }));

const betPlacedSchema = z
  .object({
    market_id: marketIdField,
    bettor: text,
    outcome: text,
    amount: int,
    nonce: int,
    timestamp: int,
  })
  .transform((p, ctx) => ({
    marketId: p.market_id,
    fields: {
      bettor: addressOf(p.bettor, "bettor", ctx),
      outcome: p.outcome,
      amount: i128Of(p.amount, "amount", ctx),
      nonce: u64Of(p.nonce, "nonce", ctx),
      timestamp: u64Of(p.timestamp, "timestamp", ctx),
    } satisfies BetPlacedFields,
  }));

const betUpdatedSchema = z
  .object({
    market_id: marketIdField,
    bettor: text,
    old_status: text,
    new_status: text,
    // Option<i128>: `None` is ScVal void, which scValToNative maps to null.
    payout_amount: int.nullish(),
    nonce: int,
    timestamp: int,
  })
  .transform((p, ctx) => ({
    marketId: p.market_id,
    fields: {
      bettor: addressOf(p.bettor, "bettor", ctx),
      oldStatus: p.old_status,
      newStatus: p.new_status,
      payoutAmount:
        p.payout_amount === null || p.payout_amount === undefined
          ? null
          : i128Of(p.payout_amount, "payout_amount", ctx),
      nonce: u64Of(p.nonce, "nonce", ctx),
      timestamp: u64Of(p.timestamp, "timestamp", ctx),
    } satisfies BetUpdatedFields,
  }));

const marketResolvedSchema = z
  .object({
    market_id: marketIdField,
    final_outcome: text,
    oracle_result: text,
    community_consensus: text,
    resolution_method: text,
    confidence_score: int,
    nonce: int,
    timestamp: int,
  })
  .transform((p, ctx) => ({
    marketId: p.market_id,
    fields: {
      resolutionMethod: p.resolution_method,
      finalOutcome: p.final_outcome,
      oracleResult: p.oracle_result,
      communityConsensus: p.community_consensus,
      confidenceScore: i128Of(p.confidence_score, "confidence_score", ctx),
      nonce: u64Of(p.nonce, "nonce", ctx),
      timestamp: u64Of(p.timestamp, "timestamp", ctx),
    } satisfies MarketResolvedFields,
  }));

const winningsClaimedSchema = z
  .object({
    market_id: marketIdField,
    user: text,
    amount: int,
    nonce: int,
    timestamp: int,
  })
  .transform((p, ctx) => ({
    marketId: p.market_id,
    fields: {
      user: addressOf(p.user, "user", ctx),
      amount: i128Of(p.amount, "amount", ctx),
      nonce: u64Of(p.nonce, "nonce", ctx),
      timestamp: u64Of(p.timestamp, "timestamp", ctx),
    } satisfies WinningsClaimedFields,
  }));

const PAYLOAD_SCHEMAS: Record<
  DecodedTopic,
  z.ZodType<{ marketId: string; fields: object }, z.ZodTypeDef, unknown>
> = {
  mkt_crt: marketCreatedSchema,
  bet_plc: betPlacedSchema,
  bet_upd: betUpdatedSchema,
  mkt_res: marketResolvedSchema,
  win_clm: winningsClaimedSchema,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toScVal(input: xdr.ScVal | string): xdr.ScVal {
  return typeof input === "string" ? xdr.ScVal.fromXDR(input, "base64") : input;
}

function safeBase64(input: xdr.ScVal | string): string {
  try {
    return typeof input === "string" ? input : input.toXDR("base64");
  } catch {
    return "";
  }
}

function rawOf(raw: RawContractEvent): RawXdr {
  return {
    topics: Array.from(raw.topic ?? [], safeBase64),
    value: raw.value === undefined ? "" : safeBase64(raw.value),
  };
}

function symbolText(value: xdr.ScVal | undefined): string | null {
  if (value === undefined || value.switch().name !== "scvSymbol") return null;
  return value.sym().toString();
}

/** Symbol or String topic element as text; null for any other ScVal type. */
function textOf(value: xdr.ScVal | undefined): string | null {
  if (value === undefined) return null;
  const kind = value.switch().name;
  if (kind === "scvSymbol") return value.sym().toString();
  if (kind === "scvString") return value.str().toString();
  return null;
}

const TWO_POW_64 = BigInt(1) << BigInt(64);

/**
 * scValToNative with fast paths for the two conversions that dominate its
 * cost (Address and 128-bit integers). Every other ScVal type, and any address
 * type other than account/contract, is delegated to scValToNative unchanged.
 * Containers are walked here so the fast paths apply to struct fields.
 */
function nativeOf(value: xdr.ScVal): unknown {
  switch (value.switch().name) {
    case "scvMap": {
      const out: Record<string, unknown> = {};
      for (const entry of value.map() ?? []) {
        out[nativeOf(entry.key()) as string] = nativeOf(entry.val());
      }
      return out;
    }
    case "scvVec":
      return (value.vec() ?? []).map(nativeOf);
    case "scvSymbol":
      return value.sym().toString();
    case "scvString":
      return value.str().toString();
    case "scvU64":
      return value.u64().toBigInt();
    case "scvI128": {
      const parts = value.i128();
      return BigInt(parts.hi().toString()) * TWO_POW_64 + BigInt(parts.lo().toString());
    }
    case "scvU128": {
      const parts = value.u128();
      return BigInt(parts.hi().toString()) * TWO_POW_64 + BigInt(parts.lo().toString());
    }
    case "scvAddress": {
      const address = value.address();
      switch (address.switch().name) {
        case "scAddressTypeAccount":
          return strkeyOf("G", address.accountId().ed25519() as unknown as Buffer);
        case "scAddressTypeContract":
          return strkeyOf("C", address.contractId() as unknown as Buffer);
        default:
          return scValToNative(value);
      }
    }
    default:
      return scValToNative(value);
  }
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Decoder ─────────────────────────────────────────────────────────────────

/**
 * Decode one raw Predictify contract event. Pure: the same input always yields
 * the same output and nothing is thrown.
 */
export function decodePredictifyEvent(raw: RawContractEvent): DecodeResult {
  let topics: xdr.ScVal[];
  let value: xdr.ScVal;
  try {
    topics = Array.from(raw.topic, toScVal);
    value = toScVal(raw.value);
  } catch (err) {
    return {
      status: "invalid",
      eventType: "invalid:topic",
      marketId: null,
      errors: [`malformed XDR: ${messageOf(err)}`],
      raw: rawOf(raw),
    };
  }

  const symbol = symbolText(topics[0]);
  if (symbol === null) {
    return {
      status: "invalid",
      eventType: "invalid:topic",
      marketId: null,
      errors: ["topic[0] is missing or is not a Symbol"],
      raw: rawOf(raw),
    };
  }

  const topicMarketId = symbolText(topics[1]);
  const canonical: DecodedTopic | undefined = DECODED_TOPIC_SET.has(symbol)
    ? (symbol as DecodedTopic)
    : TOPIC_ALIAS_MAP.get(symbol);

  if (canonical === undefined) {
    return {
      status: "unknown",
      eventType: `unknown:${symbol}`,
      marketId: topicMarketId,
      raw: rawOf(raw),
    };
  }

  const invalid = (errors: string[]): InvalidEvent => ({
    status: "invalid",
    eventType: `invalid:${canonical}`,
    marketId: topicMarketId,
    errors,
    raw: rawOf(raw),
  });

  if (topicMarketId === null || topicMarketId === "") {
    return invalid(["topic[1] (market_id) is missing or is not a Symbol"]);
  }

  let native: unknown;
  try {
    native = nativeOf(value);
  } catch (err) {
    return invalid([`payload conversion failed: ${messageOf(err)}`]);
  }

  const parsed = PAYLOAD_SCHEMAS[canonical].safeParse(native);
  if (!parsed.success) {
    return invalid(issuesOf(parsed.error));
  }

  const { marketId, fields } = parsed.data;
  if (marketId !== topicMarketId) {
    return invalid([`payload market_id "${marketId}" does not match topic[1] "${topicMarketId}"`]);
  }

  if (canonical === "mkt_res") {
    const topicMethod = textOf(topics[2]);
    const payloadMethod = (fields as MarketResolvedFields).resolutionMethod;
    if (topicMethod === null) {
      return invalid(["topic[2] (resolution_method) is missing or is not a String/Symbol"]);
    }
    if (topicMethod !== payloadMethod) {
      return invalid([
        `payload resolution_method "${payloadMethod}" does not match topic[2] "${topicMethod}"`,
      ]);
    }
  }

  return { status: "decoded", eventType: canonical, marketId, ...fields } as DecodedEvent;
}

/** The JSON-safe object persisted in `indexer_events.data` for a decode result. */
export function eventDataOf(result: DecodeResult): Record<string, unknown> {
  if (result.status === "decoded") {
    const fields: Record<string, unknown> = { ...result };
    delete fields.status;
    delete fields.eventType;
    delete fields.marketId;
    return fields;
  }
  if (result.status === "invalid") {
    return { raw: result.raw, errors: result.errors };
  }
  return { raw: result.raw };
}
