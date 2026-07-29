import { createDbCursorStore, type IndexedEvent } from "../src/db/indexerRepository";
import { contractEvents, indexerCursor } from "../src/db/schema";
import type { Database } from "../src/db/client";

const sampleEvent: IndexedEvent = {
  id: "evt-1",
  ledger: 105,
  contractId: "C...",
  type: "contract",
  txHash: "tx-1",
  ledgerClosedAt: 1718919600, // Unix epoch seconds
  topic: '["xdr:t"]',
  value: "xdr:v",
};

/**
 * Records the order of insert targets and whether the cursor write happened
 * inside the same transaction callback. `failEventsInsert` makes the event
 * insert reject so we can assert the transaction aborts before the cursor write.
 */
function makeFakeDb(opts: { failEventsInsert?: boolean } = {}) {
  const ops: string[] = [];
  let cursorWritten = false;

  const insert = (table: unknown) => {
    const isEvents = table === contractEvents;
    const isCursor = table === indexerCursor;
    const builder = {
      values() {
        return builder;
      },
      onConflictDoNothing() {
        ops.push("insert:events");
        if (isEvents && opts.failEventsInsert) {
          return Promise.reject(new Error("insert failed"));
        }
        return Promise.resolve();
      },
      onConflictDoUpdate() {
        if (isCursor) {
          ops.push("upsert:cursor");
          cursorWritten = true;
        }
        return Promise.resolve();
      },
    };
    return builder;
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ lastLedger: 42 }],
        }),
      }),
    }),
    async transaction(cb: (tx: unknown) => Promise<void>) {
      // Mirrors pg/drizzle: an error thrown in the callback aborts the tx.
      await cb({ insert });
    },
  };

  return { db: db as unknown as Database, ops, get cursorWritten() {
    return cursorWritten;
  } };
}

describe("createDbCursorStore", () => {
  it("loads the current ledger from the cursor row", async () => {
    const { db } = makeFakeDb();
    const store = createDbCursorStore(db);
    expect(await store.loadLedger()).toBe(42);
  });

  it("inserts events then advances the cursor within one transaction", async () => {
    const { db, ops } = makeFakeDb();
    const store = createDbCursorStore(db);

    await store.commit([sampleEvent], 110);

    expect(ops).toEqual(["insert:events", "upsert:cursor"]);
  });

  it("aborts the cursor advance when the event insert fails", async () => {
    const fake = makeFakeDb({ failEventsInsert: true });
    const store = createDbCursorStore(fake.db);

    await expect(store.commit([sampleEvent], 110)).rejects.toThrow("insert failed");
    // The cursor upsert never ran because the transaction aborted first.
    expect(fake.cursorWritten).toBe(false);
  });

  it("skips the event insert entirely when there are no events", async () => {
    const { db, ops } = makeFakeDb();
    const store = createDbCursorStore(db);

    await store.commit([], 110);

    expect(ops).toEqual(["upsert:cursor"]);
  });
});
