/**
 * Tests for IndexerService reorg handling and deduplication.
 *
 * The production Drizzle store and Soroban RPC client are replaced by an
 * in-memory store and a mock fetcher, so these tests run with no database
 * or network dependency.
 */

import {
  IndexerService,
  IndexerStore,
  RawEvent,
  StoredEventRef,
  eventKey,
  parseOpIndex,
} from "../src/services/indexerService";

// ── In-memory IndexerStore ────────────────────────────────────────────────────

class MemoryIndexerStore implements IndexerStore {
  private cursor = 0;
  private events: RawEvent[] = [];
  /** Tracks deleteFromLedger calls so tests can assert rollback behaviour */
  readonly deletedFromLedgers: number[] = [];

  async getLastLedger(): Promise<number> {
    return this.cursor;
  }

  async setLastLedger(ledger: number): Promise<void> {
    this.cursor = ledger;
  }

  async getEventsInWindow(fromLedger: number): Promise<StoredEventRef[]> {
    return this.events
      .filter((e) => e.ledger >= fromLedger)
      .map((e) => ({ ledger: e.ledger, txHash: e.txHash, opIndex: e.opIndex, id: e.id }));
  }

  async insertEventIgnoreDuplicate(event: RawEvent): Promise<void> {
    const exists = this.events.some(
      (e) => e.ledger === event.ledger && e.txHash === event.txHash && e.opIndex === event.opIndex,
    );
    if (!exists) this.events.push({ ...event });
  }

  async deleteFromLedger(fromLedger: number): Promise<void> {
    this.deletedFromLedgers.push(fromLedger);
    this.events = this.events.filter((e) => e.ledger < fromLedger);
  }

  /** Test helper: read all stored events */
  all(): RawEvent[] {
    return [...this.events];
  }
}

// ── Event builder ─────────────────────────────────────────────────────────────

function makeEvent(ledger: number, txHash: string, opIndex: number): RawEvent {
  return {
    ledger,
    txHash,
    opIndex,
    id: `${String(ledger).padStart(11, "0")}-${String(0).padStart(11, "0")}-${String(opIndex).padStart(11, "0")}`,
    contractId: "CTEST_CONTRACT",
    topicXdr: ["AAAAAA=="],
    valueXdr: "AAAAAA==",
    ledgerClosedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

const CONFIG = { contractId: "CTEST", startLedger: 90, rewindLedgers: 10 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(store: MemoryIndexerStore, events: RawEvent[]) {
  return new IndexerService(store, async () => events, CONFIG);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseOpIndex", () => {
  it("extracts the last segment as a number", () => {
    expect(parseOpIndex("00000000100-00000000001-00000000003")).toBe(3);
  });

  it("returns 0 for an unparseable id", () => {
    expect(parseOpIndex("bad-id")).toBe(0);
  });
});

describe("eventKey", () => {
  it("produces a stable composite key", () => {
    expect(eventKey({ ledger: 100, txHash: "abc", opIndex: 2 })).toBe("100:abc:2");
  });
});

describe("IndexerService.pollOnce — normal ingestion", () => {
  it("inserts events and advances the cursor", async () => {
    const store = new MemoryIndexerStore();
    const events = [
      makeEvent(100, "tx1", 0),
      makeEvent(101, "tx2", 0),
      makeEvent(102, "tx3", 0),
    ];
    await makeService(store, events).pollOnce();

    expect(store.all()).toHaveLength(3);
    expect(await store.getLastLedger()).toBe(102);
  });

  it("skips the poll when startLedger is 0 and no cursor exists", async () => {
    const store = new MemoryIndexerStore();
    const cfg = { ...CONFIG, startLedger: 0 };
    const svc = new IndexerService(store, async () => [], cfg);
    await svc.pollOnce();

    expect(store.all()).toHaveLength(0);
    expect(await store.getLastLedger()).toBe(0);
  });

  it("does nothing when the RPC returns no events", async () => {
    const store = new MemoryIndexerStore();
    await new IndexerService(store, async () => [], CONFIG).pollOnce();
    expect(store.all()).toHaveLength(0);
  });

  it("uses the rewind window on subsequent ticks", async () => {
    const store = new MemoryIndexerStore();
    // Seed cursor at 105
    await store.setLastLedger(105);

    let capturedFrom: number | undefined;
    const svc = new IndexerService(
      store,
      async (from) => {
        capturedFrom = from;
        return [makeEvent(105, "tx1", 0)];
      },
      CONFIG,
    );
    await svc.pollOnce();

    // windowStart = max(startLedger=90, 105 - rewind=10) = 95
    expect(capturedFrom).toBe(95);
  });
});

describe("IndexerService.pollOnce — deduplication", () => {
  it("silently drops events already present in the store", async () => {
    const store = new MemoryIndexerStore();
    const events = [makeEvent(100, "tx1", 0), makeEvent(101, "tx2", 0)];

    // First ingest
    await makeService(store, events).pollOnce();
    expect(store.all()).toHaveLength(2);

    // Second ingest of the same events (simulates tick overlap in rewind window)
    await makeService(store, events).pollOnce();
    expect(store.all()).toHaveLength(2);
  });

  it("adds only genuinely new events on subsequent ticks", async () => {
    const store = new MemoryIndexerStore();
    const first = [makeEvent(100, "tx1", 0)];
    await makeService(store, first).pollOnce();

    const second = [makeEvent(100, "tx1", 0), makeEvent(101, "tx2", 0)];
    await makeService(store, second).pollOnce();

    expect(store.all()).toHaveLength(2);
  });
});

describe("IndexerService.pollOnce — reorg handling", () => {
  it("detects orphaned events and rolls back to the earliest orphaned ledger", async () => {
    const store = new MemoryIndexerStore();

    // ── First tick: ingest canonical chain ──────────────────────────────────
    const firstPass = [
      makeEvent(100, "tx1", 0), // will be orphaned by reorg
      makeEvent(100, "tx1", 1), // will be orphaned by reorg
      makeEvent(101, "tx2", 0), // canonical — still in RPC after reorg
    ];
    await makeService(store, firstPass).pollOnce();
    expect(store.all()).toHaveLength(3);
    await store.setLastLedger(101);

    // ── Second tick: RPC returns a reorged chain ─────────────────────────────
    // Ledger 100 now has different events; ledger 101 is unchanged.
    const reorgedPass = [
      makeEvent(100, "tx1_reorged", 0), // replaces the two orphaned events
      makeEvent(101, "tx2", 0),          // unchanged
    ];
    await makeService(store, reorgedPass).pollOnce();

    // Rollback deleted from ledger 100 (the first orphaned ledger)
    expect(store.deletedFromLedgers).toContain(100);

    // After rollback + re-ingest: tx1_reorged@100 and tx2@101 are present
    const stored = store.all();
    expect(stored).toHaveLength(2);
    expect(stored.some((e) => e.txHash === "tx1_reorged" && e.ledger === 100)).toBe(true);
    expect(stored.some((e) => e.txHash === "tx2" && e.ledger === 101)).toBe(true);

    // The original orphaned events must be gone
    expect(stored.some((e) => e.txHash === "tx1")).toBe(false);
  });

  it("rolls back to the minimum orphaned ledger when multiple ledgers are affected", async () => {
    const store = new MemoryIndexerStore();

    const firstPass = [
      makeEvent(100, "txA", 0),
      makeEvent(101, "txB", 0),
      makeEvent(102, "txC", 0), // orphaned at the lowest ledger
    ];
    await makeService(store, firstPass).pollOnce();
    await store.setLastLedger(102);

    // Reorg removes everything from 100 onwards
    const reorgedPass = [makeEvent(103, "txD", 0)];
    await makeService(store, reorgedPass).pollOnce();

    expect(store.deletedFromLedgers[store.deletedFromLedgers.length - 1]).toBe(100);
  });

  it("does NOT trigger a rollback when all persisted events match the fresh set", async () => {
    const store = new MemoryIndexerStore();
    const events = [makeEvent(100, "tx1", 0), makeEvent(101, "tx2", 0)];

    await makeService(store, events).pollOnce();
    await store.setLastLedger(101);

    // Same events returned — no reorg
    await makeService(store, events).pollOnce();

    expect(store.deletedFromLedgers).toHaveLength(0);
    expect(store.all()).toHaveLength(2);
  });

  it("re-ingests canonical events for reorged ledgers after rollback", async () => {
    const store = new MemoryIndexerStore();

    // Seed an orphaned event
    await store.insertEventIgnoreDuplicate(makeEvent(100, "orphaned_tx", 0));
    await store.setLastLedger(100);

    // Fresh tick: ledger 100 now has a different event (reorg)
    const canonical = [makeEvent(100, "canonical_tx", 0)];
    await makeService(store, canonical).pollOnce();

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].txHash).toBe("canonical_tx");
  });

  it("zero orphaned events: no rollback, no extra inserts", async () => {
    const store = new MemoryIndexerStore();
    // Store is empty — first tick, nothing to compare
    const events = [makeEvent(200, "tx1", 0)];
    await makeService(store, events).pollOnce();

    expect(store.deletedFromLedgers).toHaveLength(0);
    expect(store.all()).toHaveLength(1);
  });
});

describe("IndexerService.pollOnce — cursor management", () => {
  it("advances the cursor to the highest ledger in the fresh batch", async () => {
    const store = new MemoryIndexerStore();
    const events = [makeEvent(100, "tx1", 0), makeEvent(105, "tx2", 0), makeEvent(103, "tx3", 0)];
    await makeService(store, events).pollOnce();
    expect(await store.getLastLedger()).toBe(105);
  });

  it("does not regress the cursor when fresh events are all within the rewind window", async () => {
    const store = new MemoryIndexerStore();
    await store.setLastLedger(110);
    // Fresh events only cover ledgers up to 108 (below current cursor)
    const events = [makeEvent(105, "tx1", 0), makeEvent(108, "tx2", 0)];
    await makeService(store, events).pollOnce();
    // Cursor stays at 110 because maxLedger(108) is not > cursor(110)
    expect(await store.getLastLedger()).toBe(110);
  });
});
