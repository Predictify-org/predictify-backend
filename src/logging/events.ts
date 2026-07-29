/**
 * events.ts
 *
 * Structured log events for market state changes.
 *
 * Emitted from the service layer for observability and audit pipelines.
 * Every event includes a correlationId for distributed tracing.
 *
 * Security: payloads are sanitized to redact common sensitive keys
 * (secret, password, token, authorization, privateKey).
 *
 * See docs/log-events.md for the full event catalogue.
 */

import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

/**
 * Canonical market lifecycle events.
 *
 * Event names follow the `market.<verb>` convention and are stable
 * for downstream log consumers.
 */
export enum LogEvent {
  /** A new market was created (on-chain or admin). */
  MARKET_CREATED = "market.created",
  /** Market metadata/question was updated (admin, versioned). */
  MARKET_UPDATED = "market.updated",
  /** Market was resolved on-chain with a winning outcome. */
  MARKET_RESOLVED = "market.resolved",
  /** A dispute was opened against a market's resolution. */
  MARKET_DISPUTED = "market.disputed",
  /** Market was closed to new predictions (e.g. resolutionTime passed). */
  MARKET_CLOSED = "market.closed",
  /** Market was archived / hidden from listings. */
  MARKET_ARCHIVED = "market.archived",
  /** Market was featured on the home page by an admin. */
  MARKET_FEATURED = "market.featured",
  /** Market was unfeatured from the home page by an admin. */
  MARKET_UNFEATURED = "market.unfeatured",
}

/**
 * Base context shared by all market log events.
 */
export interface MarketLogContext {
  /** Market primary key (text id). */
  marketId: string;
  /** Explicit correlation id - falls back to request context / generated UUID. */
  correlationId?: string;
  /** Actor initiating the change (admin stellar address, user id, 'indexer', etc.). */
  actor?: string;
  /** Optimistic-concurrency version, if applicable. */
  version?: number;
  /** Additional structured fields specific to the event. */
  [key: string]: unknown;
}

/** Keys that are stripped / redacted before logging. */
const REDACTED_KEYS = new Set([
  "secret",
  "password",
  "token",
  "authorization",
  "privatekey",
  "private_key",
  "apikey",
  "api_key",
]);

/**
 * Sanitize an arbitrary object for logging.
 *
 * - Redacts known sensitive keys (case-insensitive)
 * - Leaves other fields untouched
 */
function sanitize<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

/**
 * Resolve a correlation id for log emission.
 *
 * Priority:
 *  1. Explicit correlationId passed in context
 *  2. Request-scoped ID from AsyncLocalStorage (pino-http / requestContext)
 *  3. Generated UUID v4 (for background workers / indexer)
 */
export function getCorrelationId(explicit?: string): string {
  return explicit ?? getRequestId() ?? randomUUID();
}

/**
 * Emit a structured market log event.
 *
 * Always includes:
 *   - event: LogEvent
 *   - correlationId: string
 *   - marketId: string
 *   - timestamp: added by pino
 *
 * @example
 * emitMarketEvent(LogEvent.MARKET_UPDATED, {
 *   marketId: "mkt-1",
 *   actor: "GABC...",
 *   version: 3
 * });
 */
export function emitMarketEvent(event: LogEvent, ctx: MarketLogContext): void {
  if (!ctx.marketId || typeof ctx.marketId !== "string") {
    logger.warn({ event }, "emitMarketEvent called without valid marketId - dropping");
    return;
  }

  const correlationId = getCorrelationId(ctx.correlationId);

  // Strip correlationId from the payload copy to avoid duplication
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { correlationId: _ignored, marketId, ...rest } = ctx;

  const payload = sanitize({
    event,
    correlationId,
    marketId,
    ...rest,
  });

  // pino adds timestamp/level/service automatically
  logger.info(payload, `market:${event}`);
}

/**
 * Convenience helper for service-layer callers that want to pass
 * a full context object without manually picking fields.
 */
export type { MarketLogContext as MarketEventContext };
