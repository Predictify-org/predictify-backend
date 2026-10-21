import { rpc, type xdr } from "@stellar/stellar-sdk";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getPool } from "../db/client";
import {
  decodeEventId,
  dedupeEvents,
  formatEventId,
  type DecodedEventIdentity,
  type RecoveryEvent,
} from "./indexerRecovery";
import { decodePredictifyEvent, eventDataOf } from "../indexer/eventDecoder";
import {
  indexerEventsDecodedTotal,
  indexerEventsInsertedTotal,
  indexerEventsInvalidTotal,
  indexerReorgsDetectedTotal,
} from "../metrics/registry";

export { decodeEventId, formatEventId, type DecodedEventIdentity };

export const INDEXER_CURSOR_ID = 1;

export interface LedgerGap {
  from: number;
  to: number;
}

export interface IndexerEventInput {
  id?: string;
  ledger: number;
  txHash: string;
  txApplicationOrder?: number;
  opIndex: number;
  eventIndex?: number;
  eventType?: string;
  /** Market the event is scoped to (set for decoded market-scoped events). */
  marketId?: string | null;
  payload?: unknown;
}

export interface ReorgRecoveryReport {
  inserted: number;
  replacements: number;
  repairedPredictions: number;
}

export interface SorobanRpcClient {
  getLatestLedger(): Promise<number>;
  getEvents(startLedger: number, endLedger: number): Promise<IndexerEventInput[]>;
}

export function parseEventOpIndex(eventId: string, fallback: number): number {
  const decoded = decodeEventId(eventId);
  return decoded ? decoded.opIndex : fallback;
}

export function extractMarketId(event: IndexerEventInput): string | null {
  if (event.marketId) {
    return event.marketId;
  }
  if (event.payload && typeof event.payload === "object") {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.marketId === "string") return p.marketId;
    if (typeof p.market_id === "string") return p.market_id;
  }
  return null;
}

/** The subset of an RPC `EventResponse` that mapRpcEvent reads. */
export interface RpcEventLike {
  id: string;
  type: string;
  ledger: number;
  txHash: string;
  contractId?: { contractId(): string } | null;
  topic: ReadonlyArray<xdr.ScVal>;
  value: xdr.ScVal;
}

/**
 * Turn one RPC event into an indexer row, or null when it must not be
 * persisted (not a `contract` event, or emitted by another contract).
 * Unknown and invalid topics are kept with their raw XDR; nothing throws.
 */
export function mapRpcEvent(
  event: RpcEventLike,
  contractId: string,
  fallbackIndex: number,
): IndexerEventInput | null {
  if (event.type !== "contract") {
    return null;
  }
  if (event.contractId && event.contractId.contractId() !== contractId) {
    return null;
  }

  const decoded = decodePredictifyEvent({ topic: event.topic, value: event.value });
  if (decoded.status === "decoded") {
    indexerEventsDecodedTotal.inc({ event_type: decoded.eventType });
  } else if (decoded.status === "unknown") {
    indexerEventsDecodedTotal.inc({ event_type: "unknown" });
  } else {
    indexerEventsInvalidTotal.inc({ event_type: decoded.eventType.slice("invalid:".length) });
    logger.warn(
      { txHash: event.txHash, ledger: event.ledger, eventType: decoded.eventType, errors: decoded.errors },
      "indexer: contract event failed validation; stored as invalid",
    );
  }

  return {
    ledger: event.ledger,
    txHash: event.txHash,
    opIndex: parseEventOpIndex(event.id, fallbackIndex),
    eventType: decoded.eventType,
    marketId: decoded.marketId,
    payload: eventDataOf(decoded),
  };
}

export function createSorobanRpcClient(): SorobanRpcClient {
  const server = new rpc.Server(env.SOROBAN_RPC_URL);

  return {
    async getLatestLedger(): Promise<number> {
      const latest = await server.getLatestLedger();
      return latest.sequence;
    },

    async getEvents(startLedger: number, endLedger: number): Promise<IndexerEventInput[]> {
      const collected: IndexerEventInput[] = [];
      let cursor: string | undefined;

      while (true) {
        const response = await server.getEvents({
          startLedger: cursor ? undefined : startLedger,
          cursor,
          limit: 1_000,
          filters: [
            {
              type: "contract",
              contractIds: [env.PREDICTIFY_CONTRACT_ID],
            },
          ],
        });

        if (response.events.length === 0) {
          break;
        }

        for (const event of response.events) {
          if (event.ledger > endLedger) {
            return collected;
          }
          if (event.ledger >= startLedger) {
            const decodedId = decodeEventId(event.id);
            if (!decodedId) {
              logger.warn(
                { eventId: event.id, txHash: event.txHash, ledger: event.ledger },
                "indexer skipping event with malformed event id",
              );
              continue;
            }
            const mapped = mapRpcEvent(event, env.PREDICTIFY_CONTRACT_ID, decodedId.opIndex);
            if (mapped) {
              collected.push({
                ...mapped,
                id: event.id,
                txApplicationOrder: decodedId.txApplicationOrder,
                opIndex: decodedId.opIndex,
                eventIndex: decodedId.eventIndex,
              });
            }
          }
        }

        const lastEvent = response.events[response.events.length - 1];
        if (lastEvent.ledger >= endLedger) {
          break;
        }

        cursor = lastEvent.pagingToken;
        if (!cursor) {
          break;
        }
      }

      return collected;
    },
  };
}

const GAP_SCAN_SQL = `
  WITH bounds AS (
    SELECT
      GREATEST($1::integer, COALESCE(MIN(ledger), $1::integer)) AS min_l,
      LEAST($2::integer, GREATEST(COALESCE(MAX(ledger), $1::integer), $1::integer)) AS max_l
    FROM indexer_events
    WHERE ledger BETWEEN $1 AND $2
  ),
  ledger_series AS (
    SELECT generate_series(
      (SELECT min_l FROM bounds),
      (SELECT max_l FROM bounds)
    )::integer AS ledger
  ),
  indexed AS (
    SELECT DISTINCT ledger
    FROM indexer_events
    WHERE ledger BETWEEN $1 AND $2
  )
  SELECT ls.ledger AS missing_ledger
  FROM ledger_series ls
  LEFT JOIN indexed i ON i.ledger = ls.ledger
  WHERE i.ledger IS NULL
    AND (SELECT min_l FROM bounds) <= (SELECT max_l FROM bounds)
  ORDER BY ls.ledger
`;

export function groupConsecutiveLedgers(ledgers: number[]): LedgerGap[] {
  if (ledgers.length === 0) {
    return [];
  }

  const sorted = [...ledgers].sort((a, b) => a - b);
  const gaps: LedgerGap[] = [];
  let from = sorted[0];
  let to = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const ledger = sorted[i];
    if (ledger === to + 1) {
      to = ledger;
      continue;
    }
    gaps.push({ from, to });
    from = ledger;
    to = ledger;
  }

  gaps.push({ from, to });
  return gaps;
}

export function mergeGapRanges(ranges: LedgerGap[]): LedgerGap[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: LedgerGap[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.from <= last.to + 1) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export class IndexerService {
  constructor(private readonly rpcClient: SorobanRpcClient = createSorobanRpcClient()) {}

  async getCursor(): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ last_ledger: number }>(
      "SELECT last_ledger FROM indexer_cursor WHERE id = $1",
      [INDEXER_CURSOR_ID],
    );

    if (result.rows.length === 0) {
      return env.INDEXER_START_LEDGER;
    }

    return result.rows[0].last_ledger;
  }

  async getChainTip(): Promise<number> {
    return this.rpcClient.getLatestLedger();
  }

  async findMissingLedgers(scanFrom: number, scanTo: number): Promise<number[]> {
    if (scanFrom > scanTo) {
      return [];
    }

    const pool = getPool();
    const result = await pool.query<{ missing_ledger: number }>(GAP_SCAN_SQL, [scanFrom, scanTo]);
    return result.rows.map((row) => row.missing_ledger);
  }

  async getMaxIndexedLedger(scanFrom: number, scanTo: number): Promise<number | null> {
    const pool = getPool();
    const result = await pool.query<{ max_ledger: number | null }>(
      "SELECT MAX(ledger) AS max_ledger FROM indexer_events WHERE ledger BETWEEN $1 AND $2",
      [scanFrom, scanTo],
    );
    return result.rows[0]?.max_ledger ?? null;
  }

  async detectGaps(scanFrom: number, scanTo: number, cursor: number): Promise<LedgerGap[]> {
    const missingLedgers = await this.findMissingLedgers(scanFrom, scanTo);
    const innerGaps = groupConsecutiveLedgers(missingLedgers);

    const maxIndexed = await this.getMaxIndexedLedger(scanFrom, scanTo);
    const tailStart = Math.max((maxIndexed ?? cursor) + 1, scanFrom);
    const tailGaps: LedgerGap[] = tailStart <= scanTo ? [{ from: tailStart, to: scanTo }] : [];

    return mergeGapRanges([...innerGaps, ...tailGaps]);
  }

  async persistEvents(events: IndexerEventInput[]): Promise<number> {
    const report = await this.persistEventsWithRecovery(events);
    return report.inserted;
  }

  /**
   * Persist an at-least-once RPC batch. Exact duplicates are ignored, while
   * a different transaction at the same ledger/op position replaces the old
   * canonical event and resets prediction state tied to the stale transaction.
   */
  /**
   * Persist an at-least-once RPC batch. Exact duplicates are ignored, while
   * a different transaction at the same ledger position (ledger, txApplicationOrder, opIndex, eventIndex)
   * replaces the old canonical event and resets prediction state tied to the stale transaction atomically.
   */
  async persistEventsWithRecovery(events: IndexerEventInput[]): Promise<ReorgRecoveryReport> {
    if (events.length === 0) {
      return { inserted: 0, replacements: 0, repairedPredictions: 0 };
    }

    const validEvents: IndexerEventInput[] = [];
    for (const raw of events) {
      if (raw.id) {
        const decoded = decodeEventId(raw.id);
        if (!decoded) {
          logger.warn(
            { eventId: raw.id, txHash: raw.txHash, ledger: raw.ledger },
            "indexer rejecting event with malformed event id",
          );
          continue;
        }
        validEvents.push({
          ...raw,
          ledger: raw.ledger ?? decoded.ledger,
          txApplicationOrder: raw.txApplicationOrder ?? decoded.txApplicationOrder,
          opIndex: raw.opIndex ?? decoded.opIndex,
          eventIndex: raw.eventIndex ?? decoded.eventIndex,
        });
      } else {
        validEvents.push({
          ...raw,
          txApplicationOrder: raw.txApplicationOrder ?? 0,
          opIndex: raw.opIndex ?? 0,
          eventIndex: raw.eventIndex ?? 0,
        });
      }
    }

    if (validEvents.length === 0) {
      return { inserted: 0, replacements: 0, repairedPredictions: 0 };
    }

    const pool = getPool();
    let inserted = 0;
    let replacements = 0;
    let repairedPredictions = 0;
    const uniqueEvents = dedupeEvents(validEvents as RecoveryEvent[]) as IndexerEventInput[];

    for (const event of uniqueEvents) {
      const client = typeof pool.connect === "function" ? await pool.connect() : pool;
      try {
        await client.query("BEGIN");

        const txAppOrder = event.txApplicationOrder ?? 0;
        const opIndex = event.opIndex ?? 0;
        const eventIndex = event.eventIndex ?? 0;

        // Detect canonical conflict at the same ledger position using SELECT ... FOR UPDATE
        const existing = await client.query<{ id: string; tx_hash: string }>(
          `SELECT id, tx_hash FROM indexer_events
           WHERE ledger = $1 AND tx_application_order = $2 AND op_index = $3 AND event_index = $4 AND canonical = TRUE
           FOR UPDATE`,
          [event.ledger, txAppOrder, opIndex, eventIndex],
        );

        const existingRows = existing?.rows ?? [];
        if (existingRows.length > 0) {
          const oldRow = existingRows[0];
          if (oldRow.tx_hash !== event.txHash) {
            // Reorg replacement: same position, different tx hash
            await client.query(
              `UPDATE indexer_events SET canonical = FALSE
               WHERE id = $1`,
              [oldRow.id],
            );

            const repaired = await client.query(
              `UPDATE predictions SET status = 'pending', result = NULL, last_error = NULL,
                 confirm_attempts = 0
               WHERE tx_hash = $1 AND status IN ('confirmed', 'failed')`,
              [oldRow.tx_hash],
            );
            const repairedCount = repaired.rowCount ?? 0;

            await client.query(
              `INSERT INTO indexer_reorgs (
                 ledger, tx_application_order, op_index, event_index, old_tx_hash, new_tx_hash, repaired_predictions, status
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'detected')`,
              [
                event.ledger,
                txAppOrder,
                opIndex,
                eventIndex,
                oldRow.tx_hash,
                event.txHash,
                repairedCount,
              ],
            );

            logger.warn(
              {
                ledger: event.ledger,
                txApplicationOrder: txAppOrder,
                opIndex,
                eventIndex,
                oldTxHash: oldRow.tx_hash,
                newTxHash: event.txHash,
                repairedPredictions: repairedCount,
              },
              "indexer reorg detected and predictions repaired",
            );

            indexerReorgsDetectedTotal.inc();
            replacements += 1;
            repairedPredictions += repairedCount;
          }
        }

        const marketId = extractMarketId(event);
        const payloadJson = event.payload === undefined ? null : JSON.stringify(event.payload);

        const result = await client.query(
          `INSERT INTO indexer_events (
             ledger, tx_hash, tx_application_order, op_index, event_index, event_type, market_id, data, canonical
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (ledger, tx_hash, op_index, event_index) DO NOTHING
           RETURNING id`,
          [
            event.ledger,
            event.txHash,
            txAppOrder,
            opIndex,
            eventIndex,
            event.eventType ?? "unknown",
            marketId,
            payloadJson,
            true,
          ],
        );

        await client.query("COMMIT");

        const rowCount = result.rowCount ?? 0;
        inserted += rowCount;
        if (rowCount > 0) {
          indexerEventsInsertedTotal.inc(rowCount);
        }
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        if ("release" in client && typeof client.release === "function") {
          client.release();
        }
      }
    }

    return { inserted, replacements, repairedPredictions };
  }

  async fetchEventsForRange(startLedger: number, endLedger: number): Promise<IndexerEventInput[]> {
    return this.rpcClient.getEvents(startLedger, endLedger);
  }

  /**
   * Backfills a ledger range with INDEXER_REWIND_LEDGERS overlap for reorg-safe dedupe.
   * Work is chunked by INDEXER_BACKFILL_CHUNK_SIZE to avoid OOM on large gaps.
   */
  async backfillRange(from: number, to: number): Promise<void> {
    if (from > to) {
      return;
    }

    const rewindFrom = Math.max(env.INDEXER_START_LEDGER, from - env.INDEXER_REWIND_LEDGERS);
    const chunkSize = env.INDEXER_BACKFILL_CHUNK_SIZE;

    logger.info({ from, to, rewindFrom, chunkSize }, "indexer backfill started");

    for (let chunkStart = rewindFrom; chunkStart <= to; chunkStart += chunkSize) {
      const chunkEnd = Math.min(chunkStart + chunkSize - 1, to);
      const events = await this.fetchEventsForRange(chunkStart, chunkEnd);
      const inserted = await this.persistEvents(events);
      logger.debug(
        { chunkStart, chunkEnd, fetched: events.length, inserted },
        "indexer backfill chunk complete",
      );
    }

    await this.advanceCursor(to);
    logger.info({ from, to, rewindFrom }, "indexer backfill complete");
  }

  async advanceCursor(lastLedger: number): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO indexer_cursor (id, last_ledger, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE
       SET last_ledger = GREATEST(indexer_cursor.last_ledger, EXCLUDED.last_ledger),
           updated_at = NOW()`,
      [INDEXER_CURSOR_ID, lastLedger],
    );
  }

  /** Convenience helper for tests and the main indexer worker. */
  async pollOnce(): Promise<number> {
    const cursor = await this.getCursor();
    const tip = await this.getChainTip();
    const startLedger = Math.max(env.INDEXER_START_LEDGER, cursor - env.INDEXER_REWIND_LEDGERS + 1);
    if (startLedger > tip) {
      return cursor;
    }

    const events = await this.fetchEventsForRange(startLedger, tip);
    await this.persistEvents(events);
    await this.advanceCursor(tip);
    return tip;
  }
}

export const indexerService = new IndexerService();
