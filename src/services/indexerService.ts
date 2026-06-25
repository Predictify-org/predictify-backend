/**
 * Reorg-safe Soroban event indexer.
 *
 * Each tick the service re-fetches the last INDEXER_REWIND_LEDGERS ledgers
 * from Soroban RPC and compares them against persisted events.  Any event
 * that was stored in a previous tick but is no longer returned by the RPC
 * indicates a chain reorganisation: the indexer rolls back derived state to
 * the earliest orphaned ledger, then re-ingests the canonical events.
 *
 * Duplicate events (same ledger + txHash + opIndex) are silently dropped via
 * the unique index on indexer_events — inserts use ON CONFLICT DO NOTHING.
 *
 * Dependency injection via IndexerStore / EventFetcher makes the algorithm
 * unit-testable without a live database or RPC node.
 */

import { eq, gte, inArray } from "drizzle-orm";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { logger } from "../config/logger";
import { indexerCursor, indexerEvents, markets, predictions } from "../db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";

// ── Public types ──────────────────────────────────────────────────────────────

export interface RawEvent {
  /** Soroban ledger sequence number */
  ledger: number;
  /** Full transaction hash */
  txHash: string;
  /** Event's zero-based position within the transaction */
  opIndex: number;
  /** RPC paging cursor (globally unique per event) */
  id: string;
  /** Contract Strkey (starts with 'C') */
  contractId: string;
  /** XDR-encoded topic segments (base64) */
  topicXdr: string[];
  /** XDR-encoded event value (base64) */
  valueXdr: string;
  ledgerClosedAt: Date;
}

/** Minimal projection used for reorg comparison */
export interface StoredEventRef {
  ledger: number;
  txHash: string;
  opIndex: number;
  id: string;
}

// ── Store interface ───────────────────────────────────────────────────────────
//
// Implementations: DrizzleIndexerStore (production) and MemoryIndexerStore
// (tests).  Keeping this boundary thin means the algorithm tests never touch
// a real database.

export interface IndexerStore {
  getLastLedger(): Promise<number>;
  setLastLedger(ledger: number): Promise<void>;
  /** Returns all stored events with ledger >= fromLedger */
  getEventsInWindow(fromLedger: number): Promise<StoredEventRef[]>;
  /** Insert; silently skips if (ledger, txHash, opIndex) already exists */
  insertEventIgnoreDuplicate(event: RawEvent): Promise<void>;
  /**
   * Rolls back all indexer_events and derived rows (markets, predictions)
   * with ledger / indexedLedger >= fromLedger.  Must be atomic.
   */
  deleteFromLedger(fromLedger: number): Promise<void>;
}

// ── Service ───────────────────────────────────────────────────────────────────

export interface IndexerConfig {
  contractId: string;
  startLedger: number;
  rewindLedgers: number;
}

export type EventFetcher = (fromLedger: number) => Promise<RawEvent[]>;

export class IndexerService {
  constructor(
    private readonly store: IndexerStore,
    private readonly fetchEvents: EventFetcher,
    private readonly config: IndexerConfig,
  ) {}

  async pollOnce(): Promise<void> {
    const cursor = await this.store.getLastLedger();

    // On the very first run, start from the configured ledger.
    // On subsequent runs, rewind by rewindLedgers to catch reorgs.
    const windowStart =
      cursor > 0
        ? Math.max(this.config.startLedger, cursor - this.config.rewindLedgers)
        : this.config.startLedger;

    if (windowStart <= 0) {
      logger.warn({ event: "indexer_skipped" }, "no start ledger configured; set INDEXER_START_LEDGER");
      return;
    }

    const freshEvents = await this.fetchEvents(windowStart);

    if (freshEvents.length === 0) {
      logger.debug({ event: "indexer_no_events", fromLedger: windowStart }, "no new events in window");
      return;
    }

    await this.detectAndHandleReorg(windowStart, freshEvents);
    await this.ingest(freshEvents);

    const maxLedger = Math.max(...freshEvents.map((e) => e.ledger));
    if (maxLedger > cursor) {
      await this.store.setLastLedger(maxLedger);
      logger.debug({ event: "indexer_cursor_advanced", ledger: maxLedger }, "cursor advanced");
    }
  }

  private async detectAndHandleReorg(windowStart: number, freshEvents: RawEvent[]): Promise<void> {
    const persisted = await this.store.getEventsInWindow(windowStart);
    if (persisted.length === 0) return;

    const freshKeys = new Set(freshEvents.map(eventKey));
    const orphaned = persisted.filter((e) => !freshKeys.has(eventKey(e)));

    if (orphaned.length === 0) return;

    const minOrphanedLedger = Math.min(...orphaned.map((e) => e.ledger));
    const maxFreshLedger = Math.max(...freshEvents.map((e) => e.ledger));

    logger.warn(
      {
        event: "indexer_reorg_detected",
        from: minOrphanedLedger,
        to: maxFreshLedger,
        orphanedCount: orphaned.length,
      },
      "reorg detected — rolling back derived state",
    );

    await this.store.deleteFromLedger(minOrphanedLedger);
  }

  private async ingest(events: RawEvent[]): Promise<void> {
    for (const event of events) {
      await this.store.insertEventIgnoreDuplicate(event);
    }
    logger.debug({ event: "indexer_ingested", count: events.length }, "events ingested");
  }
}

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Composite key used to detect orphaned events during reorg comparison */
export function eventKey(e: { ledger: number; txHash: string; opIndex: number }): string {
  return `${e.ledger}:${e.txHash}:${e.opIndex}`;
}

/**
 * Soroban event IDs are zero-padded cursor strings in the form
 * "LLLLLLLLLLL-TTTTTTTTTTT-EEEEEEEEEEE" (ledger-tx-event).
 * The last segment is the event's zero-based index within the transaction.
 */
export function parseOpIndex(eventId: string): number {
  const parts = eventId.split("-");
  const parsed = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── Production: Soroban RPC event fetcher ─────────────────────────────────────

export function createSorobanFetcher(rpcUrl: string, contractId: string): EventFetcher {
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  return async (fromLedger: number): Promise<RawEvent[]> => {
    // TODO: paginate when event count may exceed the RPC limit (~10 000).
    const response = await server.getEvents({
      startLedger: fromLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: 10_000,
    });

    return response.events.map((e) => ({
      ledger: e.ledger,
      txHash: e.txHash,
      opIndex: parseOpIndex(e.id),
      id: e.id,
      contractId: e.contractId?.toString() ?? contractId,
      topicXdr: e.topic.map((t) => t.toXDR("base64")),
      valueXdr: e.value.toXDR("base64"),
      ledgerClosedAt: new Date(e.ledgerClosedAt),
    }));
  };
}

// ── Production: Drizzle-backed IndexerStore ───────────────────────────────────

type DB = NodePgDatabase<typeof schema>;

export function createDrizzleStore(db: DB): IndexerStore {
  return {
    async getLastLedger(): Promise<number> {
      const rows = await db
        .select({ lastLedger: indexerCursor.lastLedger })
        .from(indexerCursor)
        .where(eq(indexerCursor.id, 1))
        .limit(1);
      return rows[0]?.lastLedger ?? 0;
    },

    async setLastLedger(ledger: number): Promise<void> {
      await db
        .insert(indexerCursor)
        .values({ id: 1, lastLedger: ledger })
        .onConflictDoUpdate({
          target: indexerCursor.id,
          set: { lastLedger: ledger, updatedAt: new Date() },
        });
    },

    async getEventsInWindow(fromLedger: number): Promise<StoredEventRef[]> {
      return db
        .select({
          ledger: indexerEvents.ledger,
          txHash: indexerEvents.txHash,
          opIndex: indexerEvents.opIndex,
          id: indexerEvents.eventId,
        })
        .from(indexerEvents)
        .where(gte(indexerEvents.ledger, fromLedger));
    },

    async insertEventIgnoreDuplicate(event: RawEvent): Promise<void> {
      await db
        .insert(indexerEvents)
        .values({
          eventId: event.id,
          ledger: event.ledger,
          txHash: event.txHash,
          opIndex: event.opIndex,
          contractId: event.contractId,
          topicXdr: event.topicXdr,
          valueXdr: event.valueXdr,
          ledgerClosedAt: event.ledgerClosedAt,
        })
        .onConflictDoNothing();
    },

    async deleteFromLedger(fromLedger: number): Promise<void> {
      // Wrapped in a transaction: predictions → markets → events
      // (predictions FK-reference markets; delete child rows first)
      await db.transaction(async (tx) => {
        const orphanedMarkets = await tx
          .select({ id: markets.id })
          .from(markets)
          .where(gte(markets.indexedLedger, fromLedger));

        if (orphanedMarkets.length > 0) {
          await tx.delete(predictions).where(
            inArray(predictions.marketId, orphanedMarkets.map((m) => m.id)),
          );
        }

        await tx.delete(markets).where(gte(markets.indexedLedger, fromLedger));
        await tx.delete(indexerEvents).where(gte(indexerEvents.ledger, fromLedger));
      });
    },
  };
}
