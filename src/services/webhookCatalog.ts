/**
 * webhookCatalog.ts
 *
 * Single source of truth for every webhook event type emitted by Predictify.
 *
 * Design decisions
 * ────────────────
 *  • Each event is modelled as a Zod schema so payloads can be validated at
 *    the dispatch site and documented via `.shape` / `.describe()`.
 *  • `WEBHOOK_EVENT_SCHEMAS` maps event-type string → Zod schema for O(1)
 *    lookup without a switch-case.
 *  • `ALL_EVENT_TYPES` and the `WebhookEventType` union are derived from the
 *    map — add a new event once, everything else updates automatically.
 *  • `buildPayload` is a thin helper that stamps the required envelope fields
 *    (`event`, `timestamp`, `id`) onto any event-specific data object, then
 *    validates the result before returning it.  This keeps dispatch sites small
 *    and ensures we never send a malformed payload.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Shared envelope fields
// ---------------------------------------------------------------------------

/**
 * Every webhook payload contains these top-level fields in addition to the
 * event-specific data below.
 */
export const WebhookEnvelopeSchema = z.object({
  /** The event type string, e.g. "market.resolved". */
  event: z.string(),
  /**
   * Unique delivery ID (UUIDv4).  Subscribers should use this to detect
   * duplicate deliveries caused by retries.
   */
  id: z.string().uuid(),
  /**
   * ISO 8601 UTC timestamp of when the event was produced on the server.
   */
  timestamp: z.string().datetime(),
});

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

// ---------------------------------------------------------------------------
// market.resolved
// ---------------------------------------------------------------------------

/**
 * Emitted when the on-chain indexer detects that a prediction market has been
 * resolved and the winning outcome has been recorded on-chain.
 *
 * The dispatcher fans this event out to every subscription which subscribes to
 * "market.resolved" or "*".
 */
export const MarketResolvedPayloadSchema = WebhookEnvelopeSchema.extend({
  event: z.literal("market.resolved"),
  /** Primary key of the market in the `markets` table. */
  marketId: z.string(),
  /**
   * The outcome string that won the market.  Matches the `outcome` values
   * stored in the `predictions` table so subscribers can easily cross-reference
   * their own records.
   */
  winningOutcome: z.string(),
  /**
   * Stellar ledger sequence number at which the resolution event was emitted
   * on-chain.
   */
  ledger: z.number().int().nonnegative(),
  /**
   * Unix timestamp (seconds since epoch) of the on-chain resolution event.
   * This may differ slightly from the envelope `timestamp` because it reflects
   * the on-chain time rather than when the indexer processed the event.
   */
  onChainTimestamp: z.number().int().nonnegative(),
});

export type MarketResolvedPayload = z.infer<typeof MarketResolvedPayloadSchema>;

// ---------------------------------------------------------------------------
// dispute.opened
// ---------------------------------------------------------------------------

/**
 * Emitted when a user who holds a confirmed prediction in a market opens a
 * dispute against that market's resolution.
 *
 * The dispatcher fans this event out to every subscription which subscribes to
 * "dispute.opened" or "*".
 */
export const DisputeOpenedPayloadSchema = WebhookEnvelopeSchema.extend({
  event: z.literal("dispute.opened"),
  /** Primary key of the market the dispute was filed against. */
  marketId: z.string(),
  /** UUID of the newly created dispute row. */
  disputeId: z.string().uuid(),
  /** UUID of the user who opened the dispute. */
  openedBy: z.string().uuid(),
  /**
   * Free-text reason provided by the disputing user.  Guaranteed to be
   * non-empty; max length is application-enforced upstream.
   */
  reason: z.string(),
  /**
   * Optional URI to supporting evidence supplied by the disputing user.
   * `null` when no evidence was attached.
   */
  evidenceUri: z.string().url().nullable().optional(),
});

export type DisputeOpenedPayload = z.infer<typeof DisputeOpenedPayloadSchema>;

// ---------------------------------------------------------------------------
// prediction.confirmed
// ---------------------------------------------------------------------------

/**
 * Emitted when the predictionsConfirmer worker detects a matching indexer
 * event for a pending prediction and transitions it to confirmed.
 *
 * The dispatcher fans this event out to every subscription which subscribes to
 * "prediction.confirmed" or "*".
 */
export const PredictionConfirmedPayloadSchema = WebhookEnvelopeSchema.extend({
  event: z.literal("prediction.confirmed"),
  /** UUID of the confirmed prediction. */
  predictionId: z.string().uuid(),
  /** Primary key of the market the prediction belongs to. */
  marketId: z.string(),
  /** UUID of the user who made the prediction. */
  userId: z.string().uuid(),
  /** The outcome the user predicted (e.g. "yes" or "no"). */
  outcome: z.string(),
  /** The amount staked on the prediction (string to preserve precision). */
  amount: z.string(),
  /** On-chain transaction hash of the bet_placed event. */
  txHash: z.string(),
});

export type PredictionConfirmedPayload = z.infer<typeof PredictionConfirmedPayloadSchema>;

// ---------------------------------------------------------------------------
// Catalog registry
// ---------------------------------------------------------------------------

/**
 * Maps every supported event-type string to its Zod validation schema.
 *
 * To add a new event type:
 *   1. Define a `*PayloadSchema` constant above.
 *   2. Add it here with its event-type string as the key.
 *
 * Everything else — type unions, validation helpers, documentation — derives
 * from this map automatically.
 */
export const WEBHOOK_EVENT_SCHEMAS = {
  "market.resolved": MarketResolvedPayloadSchema,
  "dispute.opened": DisputeOpenedPayloadSchema,
  "prediction.confirmed": PredictionConfirmedPayloadSchema,
} as const;

/** All registered event-type strings, derived from the catalog at compile time. */
export const ALL_EVENT_TYPES = Object.keys(WEBHOOK_EVENT_SCHEMAS) as WebhookEventType[];

/** Union of every supported event-type literal string. */
export type WebhookEventType = keyof typeof WEBHOOK_EVENT_SCHEMAS;

/** Union of every concrete payload type. */
export type WebhookPayload =
  | MarketResolvedPayload
  | DisputeOpenedPayload
  | PredictionConfirmedPayload;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `eventType` is a known, registered event type.
 *
 * @example
 * if (isKnownEventType(sub.events[0])) { ... }
 */
export function isKnownEventType(eventType: string): eventType is WebhookEventType {
  return Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_SCHEMAS, eventType);
}

/**
 * Validates a raw payload object against the schema for the given event type.
 *
 * @param eventType - Must be a `WebhookEventType` key in the catalog.
 * @param payload   - Raw (un-validated) object from the dispatcher.
 * @returns The validated, typed payload.
 * @throws `ZodError` when validation fails — callers should catch and log.
 */
export function validatePayload(
  eventType: WebhookEventType,
  payload: unknown,
): WebhookPayload {
  const schema = WEBHOOK_EVENT_SCHEMAS[eventType];
  return schema.parse(payload) as WebhookPayload;
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Stamp envelope metadata onto an event-specific data object and validate the
 * combined payload against the catalog schema.
 *
 * This is the recommended way to construct webhook payloads at dispatch sites
 * so the envelope fields are always consistent and validated.
 *
 * @example
 * const payload = buildPayload("market.resolved", {
 *   marketId: "mkt-123",
 *   winningOutcome: "yes",
 *   ledger: 5_000_000,
 *   onChainTimestamp: Date.now() / 1000,
 * });
 *
 * @param eventType - A registered event type key from `WEBHOOK_EVENT_SCHEMAS`.
 * @param data      - Event-specific fields (without the envelope).
 * @returns Validated, fully-typed payload ready to be JSON-serialised.
 * @throws `ZodError` when data does not satisfy the schema.
 */
export function buildPayload<T extends WebhookEventType>(
  eventType: T,
  data: Omit<z.infer<(typeof WEBHOOK_EVENT_SCHEMAS)[T]>, keyof WebhookEnvelope>,
): z.infer<(typeof WEBHOOK_EVENT_SCHEMAS)[T]> {
  const envelope: WebhookEnvelope = {
    event: eventType,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const raw = { ...envelope, ...data };
  const schema = WEBHOOK_EVENT_SCHEMAS[eventType];
  return schema.parse(raw) as z.infer<(typeof WEBHOOK_EVENT_SCHEMAS)[T]>;
}
