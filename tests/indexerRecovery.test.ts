import {
  assertCheckpointDecision,
  chunkReplayRanges,
  decideCheckpoint,
  decodeEventId,
  dedupeEvents,
  detectReorgs,
  eventIdentity,
  findUnobservedLedgers,
  formatEventId,
  groupLedgerRanges,
  IndexerRecoveryPlanner,
  mergeObservations,
  normalizeRecoveryBatch,
  positionIdentity,
  reorgAffectedRange,
  validateRecoveryEvent,
} from "../src/services/indexerRecovery";

const event = (
  ledger: number,
  txHash = `tx-${ledger}`,
  opIndex = 0,
  txApplicationOrder = 0,
  eventIndex = 0,
) => ({
  ledger,
  txHash,
  txApplicationOrder,
  opIndex,
  eventIndex,
});

describe("TOID decoding and encoding", () => {
  it("decodes a valid Soroban RPC event id into positional components", () => {
    // ledger 1000, txApplicationOrder 4, opIndex 2, eventIndex 1
    const eventId = formatEventId(1000, 4, 2, 1);
    const decoded = decodeEventId(eventId);
    expect(decoded).toEqual({
      ledger: 1000,
      txApplicationOrder: 4,
      opIndex: 2,
      eventIndex: 1,
    });
  });

  it("handles zero values for all components", () => {
    const eventId = formatEventId(0, 0, 0, 0);
    const decoded = decodeEventId(eventId);
    expect(decoded).toEqual({
      ledger: 0,
      txApplicationOrder: 0,
      opIndex: 0,
      eventIndex: 0,
    });
  });

  it("rejects malformed event ids gracefully", () => {
    expect(decodeEventId("")).toBeNull();
    expect(decodeEventId(null as unknown as string)).toBeNull();
    expect(decodeEventId(123 as unknown as string)).toBeNull();
    expect(decodeEventId("not-an-event-id")).toBeNull();
    expect(decodeEventId("12345")).toBeNull();
    expect(decodeEventId("123-456-789")).toBeNull();
    expect(decodeEventId("abc-0000000000")).toBeNull();
    expect(decodeEventId("0000000000-xyz")).toBeNull();
    expect(decodeEventId("-1-0")).toBeNull();
    expect(decodeEventId("100-9999999999999999999999999999999999999")).toBeNull();
  });
});

describe("indexer recovery identities", () => {
  it("separates event identity from ledger position", () => {
    expect(eventIdentity(event(10, "a", 1, 0, 2))).toBe("10:a:1:2");
    expect(positionIdentity(event(10, "b", 1, 3, 2))).toBe("10:3:1:2");
    expect(eventIdentity(event(10, "a", 1, 0, 2))).not.toBe(eventIdentity(event(10, "b", 1, 0, 2)));
  });

  it("deduplicates exact redelivery without dropping distinct operations", () => {
    expect(dedupeEvents([event(1), event(1), event(1, "tx-1", 1)])).toEqual([event(1), event(1, "tx-1", 1)]);
  });

  it("finds absent ledgers, including a missing tail", () => {
    expect(findUnobservedLedgers(10, 15, [{ ledger: 10, events: [] }, { ledger: 12, events: [event(12)] }, { ledger: 15, events: [] }])).toEqual([11, 13, 14]);
  });

  it("groups unordered duplicate gaps into consecutive ranges", () => {
    expect(groupLedgerRanges([8, 3, 4, 4, 9, 12])).toEqual([
      { from: 3, to: 4 },
      { from: 8, to: 9 },
      { from: 12, to: 12 },
    ]);
  });

  it("splits large gaps into bounded replay requests", () => {
    expect(chunkReplayRanges([{ from: 100, to: 106 }], 3)).toEqual([
      { from: 100, to: 102 },
      { from: 103, to: 105 },
      { from: 106, to: 106 },
    ]);
    expect(() => chunkReplayRanges([], 0)).toThrow("positive");
  });

  it("validates and canonically orders a replay batch", () => {
    expect(normalizeRecoveryBatch([event(2, "z", 1), event(1), event(2, "z", 1)])).toEqual([
      event(1),
      event(2, "z", 1),
    ]);
    expect(() => validateRecoveryEvent(event(-1))).toThrow("non-negative");
    expect(() => validateRecoveryEvent({ ledger: 1, txHash: "", opIndex: 0 })).toThrow("transaction hash");
    expect(() => validateRecoveryEvent({ ledger: 1, txHash: "tx", opIndex: -1 })).toThrow("non-negative");
    expect(() => validateRecoveryEvent({ ledger: 1, txHash: "tx", opIndex: 0, txApplicationOrder: -1 })).toThrow("non-negative");
    expect(() => validateRecoveryEvent({ ledger: 1, txHash: "tx", opIndex: 0, eventIndex: -1 })).toThrow("non-negative");
  });

  it("merges paginated observations while preserving empty-ledger evidence", () => {
    expect(mergeObservations([
      { ledger: 4, events: [event(4, "b")] },
      { ledger: 3, events: [] },
      { ledger: 4, events: [event(4, "b"), event(4, "a", 1)] },
    ])).toEqual([
      { ledger: 3, events: [] },
      { ledger: 4, events: [event(4, "b"), event(4, "a", 1)] },
    ]);
  });

  it("builds a bounded replay plan without advancing a blocked checkpoint", () => {
    const planner = new IndexerRecoveryPlanner(2);
    expect(planner.plan(10, 15, [
      { ledger: 11, events: [] },
      { ledger: 13, events: [] },
      { ledger: 15, events: [] },
    ])).toEqual([{ from: 12, to: 12 }, { from: 14, to: 14 }]);
    expect(() => planner.checkpoint(10, 15, [{ ledger: 11, events: [] }])).toThrow("checkpoint blocked");
    expect(planner.checkpoint(10, 12, [{ ledger: 11, events: [] }, { ledger: 12, events: [] }])).toBe(12);
  });
});

describe("reorg detection", () => {
  it("detects replacement at the same ledger and operation", () => {
    expect(detectReorgs([event(20, "old", 2)], [event(20, "new", 2)])).toEqual([
      { ledger: 20, txApplicationOrder: 0, opIndex: 2, eventIndex: 0, oldTxHash: "old", newTxHash: "new" },
    ]);
  });

  it("ignores same-event replay and reports multiple replacements", () => {
    expect(detectReorgs([event(20, "old", 2), event(21, "keep")], [event(20, "old", 2), event(21, "new"), event(22)])).toEqual([
      { ledger: 21, txApplicationOrder: 0, opIndex: 0, eventIndex: 0, oldTxHash: "keep", newTxHash: "new" },
    ]);
  });

  it("returns the smallest replay range covering all replacements", () => {
    expect(reorgAffectedRange([
      { ledger: 40, opIndex: 0, oldTxHash: "a", newTxHash: "b" },
      { ledger: 44, opIndex: 1, oldTxHash: "c", newTxHash: "d" },
    ])).toEqual({ from: 40, to: 44 });
    expect(reorgAffectedRange([])).toBeNull();
  });

  it("does not treat a replay with the same transaction as a reorg", () => {
    expect(detectReorgs(
      [event(30, "same", 4)],
      [event(30, "same", 4), event(30, "same", 4)],
    )).toEqual([]);
  });

  it("rejects malformed observation ledgers before planning", () => {
    const planner = new IndexerRecoveryPlanner(10);
    expect(() => planner.plan(1, 2, [{ ledger: -1, events: [] }])).toThrow("non-negative");
    expect(() => mergeObservations([{ ledger: Number.MAX_SAFE_INTEGER + 1, events: [] }])).toThrow("non-negative");
  });

  it("handles a target at or behind the current checkpoint", () => {
    const planner = new IndexerRecoveryPlanner(5);
    expect(planner.plan(100, 99, [])).toEqual([]);
    expect(planner.checkpoint(100, 99, [])).toBe(100);
  });

  it("keeps multiple operations at one position distinct", () => {
    const batch = normalizeRecoveryBatch([
      event(50, "tx", 3),
      event(50, "tx", 1),
      event(50, "tx", 2),
    ]);
    expect(batch.map((item) => item.opIndex)).toEqual([1, 2, 3]);
    expect(new Set(batch.map(eventIdentity)).size).toBe(3);
  });
});

describe("contiguous checkpoint decisions", () => {
  it("advances through empty ledgers only when they were explicitly observed", () => {
    const observations = [
      { ledger: 51, events: [] },
      { ledger: 52, events: [event(52)] },
      { ledger: 53, events: [] },
    ];
    expect(decideCheckpoint(50, 53, observations)).toEqual({ accepted: true, nextCheckpoint: 53, missing: [] });
  });

  it("refuses to cross a missing ledger and returns a replay plan", () => {
    const decision = decideCheckpoint(50, 55, [{ ledger: 51, events: [] }, { ledger: 53, events: [] }, { ledger: 54, events: [] }, { ledger: 55, events: [] }]);
    expect(decision.accepted).toBe(false);
    expect(decision.nextCheckpoint).toBe(50);
    expect(decision.missing).toEqual([{ from: 52, to: 52 }]);
    expect(() => assertCheckpointDecision(decision)).toThrow("checkpoint blocked");
  });

  it("is idempotent when a worker restarts after the checkpoint", () => {
    const observations = [{ ledger: 101, events: [event(101)] }];
    expect(decideCheckpoint(101, 101, observations)).toEqual({ accepted: true, nextCheckpoint: 101, missing: [] });
    expect(assertCheckpointDecision(decideCheckpoint(100, 101, observations))).toBe(101);
  });
});
