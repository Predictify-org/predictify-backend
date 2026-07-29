/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { contractEvents, indexerCursor } from "./schema";

export interface IndexedEvent {
  id: string;
  ledger: number;
  contractId: string;
  type: string;
  txHash: string;
  ledgerClosedAt: number;
  topic: string;
  value: unknown;
}

export interface CursorStore {
  loadLedger(): Promise<number | null>;
  commit(events: IndexedEvent[], newLedger: number): Promise<void>;
}

// The cursor table holds a single row identified by this id.
const CURSOR_ID = 1;

/**
 * Drizzle-backed {@link CursorStore}. `commit` runs the event inserts and the
 * cursor advance inside one database transaction, so a failure on either rolls
 * back both and the cursor is never left ahead of the persisted events.
 */
export function createDbCursorStore(db: Database): CursorStore {
  return {
    async loadLedger(): Promise<number | null> {
      const rows = await db
        .select({ lastLedger: indexerCursor.lastLedger })
        .from(indexerCursor)
        .where(eq(indexerCursor.id, CURSOR_ID))
        .limit(1);
      return rows.length ? rows[0].lastLedger : null;
    },

    async commit(events: IndexedEvent[], newLedger: number): Promise<void> {
      await db.transaction(async (tx: any) => {
        if (events.length > 0) {
          await tx
            .insert(contractEvents)
            .values(
              events.map((e) => ({
                id: e.id,
                ledger: e.ledger,
                contractId: e.contractId,
                type: e.type,
                txHash: e.txHash,
                ledgerClosedAt: e.ledgerClosedAt,
                topic: e.topic,
                value: e.value,
              })),
            )
            // Re-fetching an overlapping range must not error on duplicates.
            .onConflictDoNothing({ target: contractEvents.id });
        }

        await tx
          .insert(indexerCursor)
          .values({ id: CURSOR_ID, lastLedger: newLedger })
          .onConflictDoUpdate({
            target: indexerCursor.id,
            set: { lastLedger: newLedger, updatedAt: sql`now()` },
          });
      });
    },
  };
}
