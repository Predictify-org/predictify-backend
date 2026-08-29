import { rpc } from "@stellar/stellar-sdk";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getPool } from "../db/client";
import { dedupeEvents, type RecoveryEvent } from "./indexerRecovery";

export const INDEXER_CURSOR_ID = 1;

export interface LedgerGap {
  from: number;
  to: number;
}

export interface IndexerEventInput {
  ledger: number;
  txHash: string;
  opIndex: number;
  eventType?: string;
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
  const parts = eventId.split("-");
  const last = parts[parts.length - 1];
  const parsed = Number.parseInt(last ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
      let fallbackIndex = 0;

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
            collected.push({
              ledger: event.ledger,
              txHash: event.txHash,
              opIndex: parseEventOpIndex(event.id, fallbackIndex),
              eventType: event.type,
              payload: event.value,
            });
          }
          fallbackIndex += 1;
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
  async persistEventsWithRecovery(events: IndexerEventInput[]): Promise<ReorgRecoveryReport> {
    if (events.length === 0) {
      return { inserted: 0, replacements: 0, repairedPredictions: 0 };
    }

    const pool = getPool();
    let inserted = 0;
    let replacements = 0;
    let repairedPredictions = 0;
    const uniqueEvents = dedupeEvents(events as RecoveryEvent[]);

    for (const event of uniqueEvents) {
      const existing = await pool.query<{ tx_hash: string }>(
        `SELECT tx_hash FROM indexer_events
         WHERE ledger = $1 AND op_index = $2 AND canonical = TRUE
         AND tx_hash <> $3 LIMIT 1`,
        [event.ledger, event.opIndex, event.txHash],
      );
      if ((existing.rows ?? []).length > 0) {
        const oldTxHash = existing.rows[0].tx_hash;
        await pool.query(
          `UPDATE indexer_events SET canonical = FALSE
           WHERE ledger = $1 AND op_index = $2 AND tx_hash = $3`,
          [event.ledger, event.opIndex, oldTxHash],
        );
        await pool.query(
          `INSERT INTO indexer_reorgs (ledger, op_index, old_tx_hash, new_tx_hash)
           VALUES ($1, $2, $3, $4)`,
          [event.ledger, event.opIndex, oldTxHash, event.txHash],
        );
        const repaired = await pool.query(
          `UPDATE predictions SET status = 'pending', result = NULL, last_error = NULL,
             confirm_attempts = 0
           WHERE tx_hash = $1 AND status IN ('confirmed', 'failed')`,
          [oldTxHash],
        );
        replacements += 1;
        repairedPredictions += repaired.rowCount ?? 0;
      }
      const result = await pool.query(
        `INSERT INTO indexer_events (ledger, tx_hash, op_index, event_type, data, canonical)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (ledger, tx_hash, op_index) DO NOTHING
         RETURNING id`,
        [
          event.ledger,
          event.txHash,
          event.opIndex,
          event.eventType ?? "unknown",
          event.payload === undefined ? null : JSON.stringify(event.payload),
        ],
      );
      inserted += result.rowCount ?? 0;
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
