import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { markets, predictions, webhookSubscriptions } from "../db/schema";
import { logger } from "../config/logger";
import { emitMarketEvent, LogEvent } from "../logging/events";
import {
  evaluateOracleSnapshot,
  type OracleSettlementPolicy,
  type OracleSnapshot,
} from "./oracleSettlementGuard";

// ─── Public types ──────────────────────────────────────────────────────────

/** Shape of a market_resolved event emitted by the on-chain indexer. */
export interface MarketResolvedEvent {
  /** On-chain market identifier (primary key in the markets table). */
  marketId: string;
  /** The outcome string that won — must match values in predictions.outcome. */
  winningOutcome: string;
  /** Stellar ledger sequence at which the event was emitted. */
  ledger: number;
  /** Unix timestamp (seconds) of the resolution event. */
  timestamp: number;
}

export interface WebhookPayload {
  event: "market.resolved";
  marketId: string;
  winningOutcome: string;
  ledger: number;
  timestamp: number;
}

export type WebhookEmitter = (
  subscriber: { url: string; secret: string },
  payload: WebhookPayload,
) => Promise<void>;

// ─── Repository interface ──────────────────────────────────────────────────

/**
 * Thin repository abstraction — decouples the service from Drizzle so it
 * can be unit-tested without a live database.
 */
export interface MarketResolutionRepo {
  /**
   * Within a single serializable transaction:
   *  1. Lock the market row (FOR UPDATE) to prevent concurrent double-resolutions.
   *  2. If market is already "resolved" or does not exist → return false.
   *  3. SET markets.status = "resolved", markets.winning_outcome = winningOutcome.
   *  4. Bulk-SET predictions.result = "won"|"lost" via a single CASE expression.
   *
   * @returns true if this call performed the resolution; false if it was a no-op.
   */
  atomicResolve(marketId: string, winningOutcome: string): Promise<boolean>;

  /** Fetch subscribers whose events JSON array contains the given event name. */
  fetchWebhookSubscribers(event: string): Promise<Array<{ url: string; secret: string }>>;
}

// ─── Service ──────────────────────────────────────────────────────────────

/**
 * Resolves a prediction market based on a market_resolved on-chain event.
 *
 * Resolution is the bridge between on-chain truth and the off-chain UX:
 *  1. Atomically resolve the market row + bulk-categorize all predictions.
 *  2. Fan out a market.resolved webhook to every registered subscriber.
 *
 * The call is idempotent: replaying the same event with the same marketId
 * returns { processed: false } without touching the database or emitting
 * any webhooks.
 */
export async function resolveMarket(
  repo: MarketResolutionRepo,
  event: MarketResolvedEvent,
  emitWebhook: WebhookEmitter = httpWebhookEmitter,
): Promise<{ processed: boolean }> {
  const { marketId, winningOutcome } = event;

  const processed = await repo.atomicResolve(marketId, winningOutcome);

  if (!processed) {
    logger.info({ marketId }, "market_resolver: skipped — already resolved or market not found");
    return { processed: false };
  }

  // Structured audit event – emitted from service layer with correlation ID
  emitMarketEvent(LogEvent.MARKET_RESOLVED, {
    marketId,
    winningOutcome,
    ledger: event.ledger,
    timestamp: event.timestamp,
    actor: "indexer",
  });

  logger.info({ marketId, winningOutcome }, "market_resolver: resolved, fanning out webhooks");

  const subscribers = await repo.fetchWebhookSubscribers("market.resolved");

  if (subscribers.length === 0) {
    return { processed: true };
  }

  const payload: WebhookPayload = {
    event: "market.resolved",
    marketId,
    winningOutcome,
    ledger: event.ledger,
    timestamp: event.timestamp,
  };

  // Deliver to all subscribers concurrently; individual failures are logged
  // but never prevent other deliveries from completing.
  const results = await Promise.allSettled(
    subscribers.map((sub) => emitWebhook(sub, payload)),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      logger.error(
        { err: r.reason, url: subscribers[i].url, marketId },
        "market_resolver: webhook_delivery_failed",
      );
    }
  }

  return { processed: true };
}

/**
 * Settlement entry point for callers that have fetched oracle evidence. The
 * guard runs before any database mutation or webhook fan-out, so stale,
 * missing, contradictory, or unsafe fallback data cannot partially settle a
 * market. The existing event-only entry point remains available for historical
 * indexer events that already carry an on-chain winning outcome.
 */
export async function resolveMarketWithOracle(
  repo: MarketResolutionRepo,
  event: MarketResolvedEvent,
  oracle: OracleSnapshot,
  policy: OracleSettlementPolicy,
  emitWebhook: WebhookEmitter = httpWebhookEmitter,
): Promise<{ processed: boolean; oraclePrice: number }> {
  const decision = evaluateOracleSnapshot(oracle, event.timestamp, policy, event.marketId);
  if (!decision.accepted) {
    throw new Error(`oracle_settlement_rejected:${decision.reason}`);
  }
  const result = await resolveMarket(repo, event, emitWebhook);
  return { ...result, oraclePrice: decision.price };
}

// ─── Drizzle repository ────────────────────────────────────────────────────

/** Production implementation of MarketResolutionRepo backed by Drizzle ORM. */
export class DrizzleMarketResolutionRepo implements MarketResolutionRepo {
  constructor(private readonly db: Db) {}

  async atomicResolve(marketId: string, winningOutcome: string): Promise<boolean> {
    let resolved = false;

    await this.db.transaction(async (tx) => {
      // Lock the row so concurrent indexer replays don't double-resolve.
      const [market] = await tx
        .select({ status: markets.status })
        .from(markets)
        .where(eq(markets.id, marketId))
        .for("update");

      if (!market) {
        logger.warn({ marketId }, "market_resolver: market not found in database");
        return;
      }

      if (market.status === "resolved") {
        // Idempotent guard — the event has already been applied.
        return;
      }

      await tx
        .update(markets)
        .set({ status: "resolved", winningOutcome })
        .where(eq(markets.id, marketId));

      // Single bulk UPDATE avoids N+1 round-trips; the DB evaluates the CASE.
      await tx
        .update(predictions)
        .set({
          result: sql<string>`CASE WHEN ${predictions.outcome} = ${winningOutcome} THEN 'won' ELSE 'lost' END`,
        })
        .where(eq(predictions.marketId, marketId));

      resolved = true;
    });

    return resolved;
  }

  async fetchWebhookSubscribers(event: string): Promise<Array<{ url: string; secret: string }>> {
    return this.db
      .select({ url: webhookSubscriptions.url, secret: webhookSubscriptions.secret })
      .from(webhookSubscriptions)
      // @> checks that the stored JSON array contains the requested event name.
      .where(sql`${webhookSubscriptions.events} @> ${JSON.stringify([event])}::jsonb`);
  }
}

// ─── HTTP webhook emitter ──────────────────────────────────────────────────

const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Delivers a webhook POST signed with HMAC-SHA256.
 * Verifying the signature: HMAC-SHA256(secret, rawBody) === X-Predictify-Signature header value.
 */
export async function httpWebhookEmitter(
  subscriber: { url: string; secret: string },
  payload: WebhookPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", subscriber.secret)
    .update(body)
    .digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(subscriber.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Predictify-Signature": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`webhook POST to ${subscriber.url} returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
