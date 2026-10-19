/**
 * Tests for src/indexer/eventDecoder.ts and its use in the RPC client
 * (issue #979).  Fixtures are built with nativeToScVal / xdr using the exact
 * topic and payload layouts of contracts/predictify-hybrid/src/events.rs.
 */

import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import {
  DECODED_TOPICS,
  TOPIC_ALIASES,
  decodePredictifyEvent,
  eventDataOf,
  type RawContractEvent,
} from "../src/indexer/eventDecoder";
import {
  IndexerService,
  createSorobanRpcClient,
  mapRpcEvent,
  type RpcEventLike,
} from "../src/services/indexerService";
import {
  indexerEventsDecodedTotal,
  indexerEventsInvalidTotal,
  register,
} from "../src/metrics/registry";

const mockQuery = jest.fn();
jest.mock("../src/db/client", () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockGetEvents: jest.Mock = jest.fn();
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getEvents: (...args: unknown[]) => mockGetEvents(...args),
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
      })),
    },
  };
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const I128_MAX = "170141183460469231731687303715884105727";
const MARKET = "mkt_5cae97f9_0";
const BETTOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const ADMIN = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const CONTRACT_ADDR = StrKey.encodeContract(Buffer.alloc(32, 3));

type FieldType = [string, string];

function struct(values: Record<string, unknown>, types: Record<string, string>): xdr.ScVal {
  const typeMap: Record<string, FieldType> = {};
  for (const key of Object.keys(types)) typeMap[key] = ["symbol", types[key]];
  return nativeToScVal(values, { type: typeMap });
}

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
const str = (s: string): xdr.ScVal => nativeToScVal(s, { type: "string" });

function betPlaced(overrides: Record<string, unknown> = {}, drop: string[] = []): xdr.ScVal {
  const values: Record<string, unknown> = {
    market_id: MARKET,
    bettor: BETTOR,
    outcome: "Yes",
    amount: BigInt(25_000_000),
    nonce: BigInt(7),
    timestamp: BigInt(1_792_000_000),
    ...overrides,
  };
  for (const key of drop) delete values[key];
  return struct(values, {
    market_id: "symbol",
    bettor: "address",
    outcome: "string",
    amount: "i128",
    nonce: "u64",
    timestamp: "u64",
  });
}

function winningsClaimed(amount: bigint): xdr.ScVal {
  return struct(
    { market_id: MARKET, user: BETTOR, amount, nonce: BigInt(1), timestamp: BigInt(2) },
    { market_id: "symbol", user: "address", amount: "i128", nonce: "u64", timestamp: "u64" },
  );
}

function marketResolved(method = "oracle", marketId = MARKET): xdr.ScVal {
  return struct(
    {
      market_id: marketId,
      final_outcome: "Yes",
      oracle_result: "Yes",
      community_consensus: "Yes",
      resolution_method: method,
      confidence_score: BigInt(95),
      nonce: BigInt(3),
      timestamp: BigInt(4),
    },
    {
      market_id: "symbol",
      final_outcome: "string",
      oracle_result: "string",
      community_consensus: "string",
      resolution_method: "string",
      confidence_score: "i128",
      nonce: "u64",
      timestamp: "u64",
    },
  );
}

function marketCreated(marketId = MARKET): xdr.ScVal {
  return struct(
    {
      market_id: marketId,
      question: "Will BTC close above 100k?",
      outcomes: xdr.ScVal.scvVec([str("Yes"), str("No")]),
      admin: ADMIN,
      end_time: BigInt(1_793_000_000),
      nonce: BigInt(1),
      timestamp: BigInt(1_792_000_000),
    },
    {
      market_id: "symbol",
      question: "string",
      outcomes: "vec",
      admin: "address",
      end_time: "u64",
      nonce: "u64",
      timestamp: "u64",
    },
  );
}

function betUpdated(payout: bigint | null): xdr.ScVal {
  const value = struct(
    {
      market_id: MARKET,
      bettor: BETTOR,
      old_status: "Active",
      new_status: "Won",
      payout_amount: payout === null ? null : payout,
      nonce: BigInt(5),
      timestamp: BigInt(6),
    },
    {
      market_id: "symbol",
      bettor: "address",
      old_status: "string",
      new_status: "string",
      payout_amount: "i128",
      nonce: "u64",
      timestamp: "u64",
    },
  );
  return value;
}

const event = (topic: xdr.ScVal[], value: xdr.ScVal): RawContractEvent => ({ topic, value });

// ─── Test plan rows 1-6 ──────────────────────────────────────────────────────

describe("decodePredictifyEvent", () => {
  it("row 1: decodes a valid bet_plc payload", () => {
    const result = decodePredictifyEvent(event([sym("bet_plc"), sym(MARKET)], betPlaced()));
    expect(result).toMatchObject({
      status: "decoded",
      eventType: "bet_plc",
      marketId: MARKET,
      bettor: BETTOR,
      outcome: "Yes",
      amount: "25000000",
      nonce: "7",
      timestamp: "1792000000",
    });
  });

  it("row 2: decodes win_clm with amount = i128::MAX exactly (no float rounding)", () => {
    const result = decodePredictifyEvent(
      event([sym("win_clm"), sym(MARKET)], winningsClaimed(BigInt(I128_MAX))),
    );
    expect(result).toMatchObject({ status: "decoded", eventType: "win_clm", user: BETTOR });
    expect((result as { amount: string }).amount).toBe(
      "170141183460469231731687303715884105727",
    );
    expect(typeof (result as { amount: unknown }).amount).toBe("string");
  });

  it("decodes a negative i128 as an exact decimal string", () => {
    const result = decodePredictifyEvent(
      event([sym("win_clm"), sym(MARKET)], winningsClaimed(-BigInt(I128_MAX) - BigInt(1))),
    );
    expect((result as { amount: string }).amount).toBe(
      "-170141183460469231731687303715884105728",
    );
  });

  it("row 3: extracts marketId and resolutionMethod from a three-element mkt_res topic", () => {
    const result = decodePredictifyEvent(
      event([sym("mkt_res"), sym(MARKET), str("oracle")], marketResolved("oracle")),
    );
    expect(result).toMatchObject({
      status: "decoded",
      eventType: "mkt_res",
      marketId: MARKET,
      resolutionMethod: "oracle",
      confidenceScore: "95",
    });
  });

  it("accepts a Symbol-typed resolution method in topic[2]", () => {
    const result = decodePredictifyEvent(
      event([sym("mkt_res"), sym(MARKET), sym("manual")], marketResolved("manual")),
    );
    expect(result).toMatchObject({ status: "decoded", resolutionMethod: "manual" });
  });

  it("row 4: unknown topic foo_bar becomes unknown:foo_bar and keeps raw XDR", () => {
    const payload = nativeToScVal(42, { type: "u32" });
    const result = decodePredictifyEvent(event([sym("foo_bar"), sym(MARKET)], payload));
    expect(result).toMatchObject({
      status: "unknown",
      eventType: "unknown:foo_bar",
      marketId: MARKET,
    });
    const data = eventDataOf(result) as { raw: { topics: string[]; value: string } };
    expect(data.raw.topics).toEqual([sym("foo_bar").toXDR("base64"), sym(MARKET).toXDR("base64")]);
    expect(data.raw.value).toBe(payload.toXDR("base64"));
  });

  it("unknown topic without a market topic has a null marketId (e.g. stats_upd)", () => {
    const result = decodePredictifyEvent(event([sym("stats_upd")], xdr.ScVal.scvVoid()));
    expect(result).toMatchObject({ status: "unknown", eventType: "unknown:stats_upd", marketId: null });
  });

  it("row 5: bet_plc with the amount field missing is invalid:bet_plc", () => {
    const result = decodePredictifyEvent(
      event([sym("bet_plc"), sym(MARKET)], betPlaced({}, ["amount"])),
    );
    expect(result).toMatchObject({ status: "invalid", eventType: "invalid:bet_plc", marketId: MARKET });
    expect((result as { errors: string[] }).errors.join(" ")).toContain("amount");
    expect((eventDataOf(result) as { raw: { value: string } }).raw.value).toEqual(
      betPlaced({}, ["amount"]).toXDR("base64"),
    );
  });

  it("row 5 (batch continues): decoding an invalid event never throws and does not affect the next", () => {
    const batch = [
      event([sym("bet_plc"), sym(MARKET)], betPlaced({}, ["amount"])),
      event([sym("bet_plc"), sym(MARKET)], betPlaced()),
    ];
    const results = batch.map(decodePredictifyEvent);
    expect(results.map((r) => r.eventType)).toEqual(["invalid:bet_plc", "bet_plc"]);
  });

  it("row 6: long-name alias bet_placed decodes the same as bet_plc", () => {
    const canonical = decodePredictifyEvent(event([sym("bet_plc"), sym(MARKET)], betPlaced()));
    const alias = decodePredictifyEvent(event([sym("bet_placed"), sym(MARKET)], betPlaced()));
    expect(alias).toEqual(canonical);
  });

  it("every catalog alias normalises to its emitted symbol", () => {
    expect(TOPIC_ALIASES).toEqual({
      market_created: "mkt_crt",
      bet_placed: "bet_plc",
      market_resolved: "mkt_res",
      winnings_claimed: "win_clm",
    });
    for (const target of Object.values(TOPIC_ALIASES)) {
      expect(DECODED_TOPICS).toContain(target);
    }
    const created = decodePredictifyEvent(event([sym("market_created"), sym(MARKET)], marketCreated()));
    expect(created.eventType).toBe("mkt_crt");
    const resolved = decodePredictifyEvent(
      event([sym("market_resolved"), sym(MARKET), str("oracle")], marketResolved()),
    );
    expect(resolved.eventType).toBe("mkt_res");
    const claimed = decodePredictifyEvent(
      event([sym("winnings_claimed"), sym(MARKET)], winningsClaimed(BigInt(1))),
    );
    expect(claimed.eventType).toBe("win_clm");
  });

  it("treats Object.prototype names as unknown topics, not aliases", () => {
    const result = decodePredictifyEvent(event([sym("constructor"), sym(MARKET)], xdr.ScVal.scvVoid()));
    expect(result).toMatchObject({ status: "unknown", eventType: "unknown:constructor" });
  });

  it("decodes mkt_crt", () => {
    const result = decodePredictifyEvent(event([sym("mkt_crt"), sym(MARKET)], marketCreated()));
    expect(result).toMatchObject({
      status: "decoded",
      eventType: "mkt_crt",
      marketId: MARKET,
      question: "Will BTC close above 100k?",
      outcomes: ["Yes", "No"],
      admin: ADMIN,
      endTime: "1793000000",
    });
  });

  it("decodes bet_upd with and without a payout (Option<i128>)", () => {
    const won = decodePredictifyEvent(event([sym("bet_upd"), sym(MARKET)], betUpdated(BigInt(15_000_000))));
    expect(won).toMatchObject({ eventType: "bet_upd", oldStatus: "Active", newStatus: "Won", payoutAmount: "15000000" });
    const none = decodePredictifyEvent(event([sym("bet_upd"), sym(MARKET)], betUpdated(null)));
    expect(none).toMatchObject({ status: "decoded", payoutAmount: null });
  });

  it("accepts contract (C...) strkeys as addresses", () => {
    const result = decodePredictifyEvent(
      event([sym("bet_plc"), sym(MARKET)], betPlaced({ bettor: CONTRACT_ADDR })),
    );
    expect(result).toMatchObject({ status: "decoded", bettor: CONTRACT_ADDR });
  });

  it("accepts base64-encoded XDR input as returned by the RPC", () => {
    const result = decodePredictifyEvent({
      topic: [sym("bet_plc").toXDR("base64"), sym(MARKET).toXDR("base64")],
      value: betPlaced().toXDR("base64"),
    });
    expect(result).toMatchObject({ status: "decoded", eventType: "bet_plc", amount: "25000000" });
  });

  describe("invalid events", () => {
    it("rejects a payload whose market_id disagrees with topic[1]", () => {
      const result = decodePredictifyEvent(
        event([sym("bet_plc"), sym("other_mkt")], betPlaced()),
      );
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:bet_plc", marketId: "other_mkt" });
      expect((result as { errors: string[] }).errors[0]).toContain("does not match topic[1]");
    });

    it("rejects a known topic with no market topic", () => {
      const result = decodePredictifyEvent(event([sym("bet_plc")], betPlaced()));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:bet_plc", marketId: null });
    });

    it("rejects a mkt_res whose topic[2] is missing or of the wrong type", () => {
      const missing = decodePredictifyEvent(event([sym("mkt_res"), sym(MARKET)], marketResolved()));
      expect(missing).toMatchObject({ status: "invalid", eventType: "invalid:mkt_res" });
      const wrongType = decodePredictifyEvent(
        event([sym("mkt_res"), sym(MARKET), nativeToScVal(1, { type: "u32" })], marketResolved()),
      );
      expect(wrongType).toMatchObject({ status: "invalid", eventType: "invalid:mkt_res" });
    });

    it("rejects a mkt_res whose topic[2] disagrees with the payload", () => {
      const result = decodePredictifyEvent(
        event([sym("mkt_res"), sym(MARKET), str("manual")], marketResolved("oracle")),
      );
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:mkt_res" });
      expect((result as { errors: string[] }).errors[0]).toContain("resolution_method");
    });

    it("rejects a bettor string that is not a strkey (payload carries a Symbol)", () => {
      const value = struct(
        {
          market_id: MARKET,
          bettor: "GNOTAREALADDRESS",
          outcome: "Yes",
          amount: BigInt(1),
          nonce: BigInt(1),
          timestamp: BigInt(1),
        },
        {
          market_id: "symbol",
          bettor: "symbol",
          outcome: "string",
          amount: "i128",
          nonce: "u64",
          timestamp: "u64",
        },
      );
      const result = decodePredictifyEvent(event([sym("bet_plc"), sym(MARKET)], value));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:bet_plc" });
      expect((result as { errors: string[] }).errors.join(" ")).toContain("strkey");
    });

    it("rejects amount of the wrong type (u32 instead of i128)", () => {
      const value = struct(
        {
          market_id: MARKET,
          bettor: BETTOR,
          outcome: "Yes",
          amount: 5,
          nonce: BigInt(1),
          timestamp: BigInt(1),
        },
        {
          market_id: "symbol",
          bettor: "address",
          outcome: "string",
          amount: "u32",
          nonce: "u64",
          timestamp: "u64",
        },
      );
      const bad = decodePredictifyEvent(event([sym("bet_plc"), sym(MARKET)], value));
      expect(bad).toMatchObject({ status: "invalid", eventType: "invalid:bet_plc" });
    });

    it("rejects an amount outside the i128 range (u128 above i128::MAX)", () => {
      const value = struct(
        {
          market_id: MARKET,
          user: BETTOR,
          amount: BigInt(I128_MAX) + BigInt(1),
          nonce: BigInt(1),
          timestamp: BigInt(1),
        },
        { market_id: "symbol", user: "address", amount: "u128", nonce: "u64", timestamp: "u64" },
      );
      const result = decodePredictifyEvent(event([sym("win_clm"), sym(MARKET)], value));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:win_clm" });
      expect((result as { errors: string[] }).errors.join(" ")).toContain("out of i128 range");
    });

    it("rejects a negative nonce (i64 where u64 is required)", () => {
      const value = struct(
        { market_id: MARKET, user: BETTOR, amount: BigInt(1), nonce: -BigInt(1), timestamp: BigInt(1) },
        { market_id: "symbol", user: "address", amount: "i128", nonce: "i64", timestamp: "u64" },
      );
      const result = decodePredictifyEvent(event([sym("win_clm"), sym(MARKET)], value));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:win_clm" });
      expect((result as { errors: string[] }).errors.join(" ")).toContain("out of u64 range");
    });

    it("rejects an address type that is neither an account nor a contract", () => {
      // The installed SDK only knows account and contract addresses, so a future
      // address kind is simulated with a stand-in ScVal.
      const exotic = {
        switch: () => ({ name: "scvAddress", value: 18 }),
        address: () => ({ switch: () => ({ name: "scAddressTypeFuture" }) }),
      } as unknown as xdr.ScVal;
      const value = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: sym("market_id"), val: sym(MARKET) }),
        new xdr.ScMapEntry({ key: sym("user"), val: exotic }),
      ]);
      const result = decodePredictifyEvent(event([sym("win_clm"), sym(MARKET)], value));
      expect(result.status).toBe("invalid");
    });

    it("never throws even when the payload object itself misbehaves", () => {
      const hostile = {
        switch: () => {
          throw new Error("boom");
        },
        toXDR: () => {
          throw new Error("no xdr");
        },
      } as unknown as xdr.ScVal;
      const result = decodePredictifyEvent(event([sym("bet_plc"), sym(MARKET)], hostile));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:bet_plc" });
      expect((result as { errors: string[] }).errors[0]).toContain("payload conversion failed");
      expect(eventDataOf(result)).toMatchObject({ raw: { value: "" } });
    });

    it("rejects a payload that is not a map", () => {
      const result = decodePredictifyEvent(event([sym("win_clm"), sym(MARKET)], xdr.ScVal.scvVoid()));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:win_clm" });
    });

    it("handles an empty topic list", () => {
      const result = decodePredictifyEvent(event([], xdr.ScVal.scvVoid()));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:topic", marketId: null });
    });

    it("handles topic[0] that is not a Symbol", () => {
      const result = decodePredictifyEvent(event([str("bet_plc")], xdr.ScVal.scvVoid()));
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:topic" });
    });

    it("handles malformed base64 XDR without throwing", () => {
      const result = decodePredictifyEvent({ topic: ["not-xdr!!"], value: "also-bad" });
      expect(result).toMatchObject({ status: "invalid", eventType: "invalid:topic" });
      expect(eventDataOf(result)).toMatchObject({ raw: { topics: ["not-xdr!!"], value: "also-bad" } });
    });

    it("handles a payload ScVal that cannot be converted to a native value", () => {
      const result = decodePredictifyEvent(
        event([sym("win_clm"), sym(MARKET)], xdr.ScVal.scvLedgerKeyContractInstance()),
      );
      expect(result.status).toBe("invalid");
    });
  });

  describe("properties", () => {
    it("is deterministic and does not mutate its input", () => {
      const raw = event([sym("bet_plc"), sym(MARKET)], betPlaced());
      const before = raw.value instanceof Object ? (raw.value as xdr.ScVal).toXDR("base64") : "";
      const a = decodePredictifyEvent(raw);
      const b = decodePredictifyEvent(raw);
      expect(a).toEqual(b);
      expect((raw.value as xdr.ScVal).toXDR("base64")).toBe(before);
    });

    it("produces JSON-safe data (no bigint) for every status", () => {
      const results = [
        decodePredictifyEvent(event([sym("win_clm"), sym(MARKET)], winningsClaimed(BigInt(I128_MAX)))),
        decodePredictifyEvent(event([sym("foo_bar")], xdr.ScVal.scvVoid())),
        decodePredictifyEvent(event([sym("bet_plc"), sym(MARKET)], betPlaced({}, ["amount"]))),
      ];
      for (const r of results) {
        expect(() => JSON.stringify(eventDataOf(r))).not.toThrow();
      }
      expect(eventDataOf(results[0])).toEqual({
        user: BETTOR,
        amount: I128_MAX,
        nonce: "1",
        timestamp: "2",
      });
    });

    it("benchmark: decodes 10,000 events in under 500 ms", () => {
      const events = [
        event([sym("bet_plc"), sym(MARKET)], betPlaced()),
        event([sym("win_clm"), sym(MARKET)], winningsClaimed(BigInt(I128_MAX))),
        event([sym("mkt_res"), sym(MARKET), str("oracle")], marketResolved()),
        event([sym("mkt_crt"), sym(MARKET)], marketCreated()),
        event([sym("foo_bar")], xdr.ScVal.scvVoid()),
      ];
      const N = 10_000;
      decodePredictifyEvent(events[0]); // warm up
      // Measured as process CPU time (user + system), best of 3 full runs, so a
      // busy host stealing cycles does not inflate the figure; wall time is
      // logged alongside it.
      const runs: number[] = [];
      const walls: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const cpuStart = process.cpuUsage();
        const wallStart = process.hrtime.bigint();
        for (let i = 0; i < N; i += 1) {
          decodePredictifyEvent(events[i % events.length]);
        }
        const cpu = process.cpuUsage(cpuStart);
        walls.push(Number(process.hrtime.bigint() - wallStart) / 1e6);
        runs.push((cpu.user + cpu.system) / 1000);
      }
      const ms = Math.min(...runs);
      // eslint-disable-next-line no-console
      console.log(
        `BENCH decodePredictifyEvent x${N}: best cpu ${ms.toFixed(1)} ms (cpu runs: ${runs.map((r) => r.toFixed(1)).join(", ")}; wall runs: ${walls.map((r) => r.toFixed(1)).join(", ")})`,
      );
      // Coverage instrumentation (jest --coverage) slows this loop several-fold,
      // so the 500 ms budget is enforced on uninstrumented runs and a loose
      // sanity bound applies to instrumented ones.
      const instrumented = Boolean((globalThis as { __coverage__?: unknown }).__coverage__);
      expect(ms).toBeLessThan(instrumented ? 2500 : 500);
    });
  });
});

// ─── Row 10: testnet-shaped fixture ──────────────────────────────────────────

describe("row 10: testnet fixture for mkt_5cae97f9_0", () => {
  /**
   * NOTE: This fixture is NOT a captured RPC response. The testnet RPC
   * (soroban-testnet.stellar.org) returned zero events for contract
   * CCWRJXIUBSMFQ4AF2RXXH3AFBW6MEZG4GK4IYES7C4Z3X4PR6K7VAFHC inside its
   * retention window (ledgers 5155054-5276013) on 2026-10-19, so the mkt_crt
   * event was built from the events.rs layout and serialised to base64 exactly
   * as getEvents returns topic/value (see mapRpcEvent for the same shape).
   */
  const rpcShaped = {
    topic: [sym("mkt_crt").toXDR("base64"), sym("mkt_5cae97f9_0").toXDR("base64")],
    value: marketCreated("mkt_5cae97f9_0").toXDR("base64"),
  };

  it("decodes into a mkt_crt for mkt_5cae97f9_0", () => {
    const result = decodePredictifyEvent(rpcShaped);
    expect(result).toMatchObject({
      status: "decoded",
      eventType: "mkt_crt",
      marketId: "mkt_5cae97f9_0",
    });
  });
});

// ─── Rows 7 + RPC client / persistence wiring ────────────────────────────────

describe("RPC client integration", () => {
  const CONTRACT_ID = process.env.PREDICTIFY_CONTRACT_ID as string;
  const ownContract = { contractId: () => CONTRACT_ID };

  function rpcEvent(overrides: Partial<RpcEventLike> = {}): RpcEventLike {
    return {
      id: "0000000001-0000000002",
      type: "contract",
      ledger: 100,
      txHash: "tx-100",
      contractId: ownContract,
      topic: [sym("bet_plc"), sym(MARKET)],
      value: betPlaced(),
      ...overrides,
    };
  }

  async function counterValue(
    counter: typeof indexerEventsDecodedTotal | typeof indexerEventsInvalidTotal,
    label: string,
  ): Promise<number> {
    const metric = await counter.get();
    return metric.values.find((v) => v.labels.event_type === label)?.value ?? 0;
  }

  beforeEach(() => {
    mockGetEvents.mockReset();
    mockQuery.mockReset();
  });

  it("row 7: system and diagnostic events are filtered out before persistence", () => {
    expect(mapRpcEvent(rpcEvent({ type: "system" }), CONTRACT_ID, 0)).toBeNull();
    expect(mapRpcEvent(rpcEvent({ type: "diagnostic" }), CONTRACT_ID, 0)).toBeNull();
  });

  it("filters events emitted by a different contract", () => {
    const other = { contractId: () => "COTHERCONTRACT" };
    expect(mapRpcEvent(rpcEvent({ contractId: other }), CONTRACT_ID, 0)).toBeNull();
  });

  it("maps a bet_plc event to topic symbol, marketId and JSON-safe payload", async () => {
    const before = await counterValue(indexerEventsDecodedTotal, "bet_plc");
    const row = mapRpcEvent(rpcEvent(), CONTRACT_ID, 0);
    expect(row).toEqual({
      ledger: 100,
      txHash: "tx-100",
      opIndex: 2,
      eventType: "bet_plc",
      marketId: MARKET,
      payload: { bettor: BETTOR, outcome: "Yes", amount: "25000000", nonce: "7", timestamp: "1792000000" },
    });
    expect(() => JSON.stringify(row)).not.toThrow();
    expect(await counterValue(indexerEventsDecodedTotal, "bet_plc")).toBe(before + 1);
  });

  it("keeps unknown events as unknown:<symbol> with raw XDR and counts them under 'unknown'", async () => {
    const before = await counterValue(indexerEventsDecodedTotal, "unknown");
    const row = mapRpcEvent(
      rpcEvent({ topic: [sym("foo_bar"), sym(MARKET)], value: xdr.ScVal.scvVoid() }),
      CONTRACT_ID,
      0,
    );
    expect(row?.eventType).toBe("unknown:foo_bar");
    expect(row?.marketId).toBe(MARKET);
    expect((row?.payload as { raw: { value: string } }).raw.value).toBe(
      xdr.ScVal.scvVoid().toXDR("base64"),
    );
    expect(await counterValue(indexerEventsDecodedTotal, "unknown")).toBe(before + 1);
  });

  it("keeps invalid events as invalid:<symbol> and increments the invalid counter", async () => {
    const before = await counterValue(indexerEventsInvalidTotal, "bet_plc");
    const row = mapRpcEvent(rpcEvent({ value: betPlaced({}, ["amount"]) }), CONTRACT_ID, 0);
    expect(row?.eventType).toBe("invalid:bet_plc");
    expect(row?.payload).toMatchObject({ errors: expect.any(Array), raw: { topics: expect.any(Array) } });
    expect(await counterValue(indexerEventsInvalidTotal, "bet_plc")).toBe(before + 1);
  });

  it("exposes the counters on the metrics registry", async () => {
    const text = await register.metrics();
    expect(text).toContain("indexer_events_decoded_total");
    expect(text).toContain("indexer_events_invalid_total");
  });

  it("getEvents returns decoded rows, drops non-contract events and never throws on bad events", async () => {
    mockGetEvents.mockResolvedValueOnce({
      events: [
        { ...rpcEvent(), pagingToken: "p1" },
        { ...rpcEvent({ id: "0000000001-0000000003", type: "diagnostic" }), pagingToken: "p2" },
        {
          ...rpcEvent({ id: "0000000001-0000000004", value: betPlaced({}, ["amount"]) }),
          pagingToken: "p3",
        },
      ],
    });
    const client = createSorobanRpcClient();
    const events = await client.getEvents(100, 100);
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      }),
    );
    expect(events.map((e) => e.eventType)).toEqual(["bet_plc", "invalid:bet_plc"]);
    expect(events[0].marketId).toBe(MARKET);
  });

  it("persists market_id and a JSON-safe data column", async () => {
    const service = new IndexerService({ getLatestLedger: jest.fn(), getEvents: jest.fn() });
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 });
    const row = mapRpcEvent(rpcEvent(), CONTRACT_ID, 0);
    await service.persistEventsWithRecovery([row!]);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("market_id");
    expect(params.slice(0, 5)).toEqual([100, "tx-100", 2, "bet_plc", MARKET]);
    expect(JSON.parse(params[5])).toMatchObject({ bettor: BETTOR, amount: "25000000" });
  });
});
