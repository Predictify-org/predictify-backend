process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "a".repeat(32);
process.env.SOROBAN_RPC_URL = "https://rpc.testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon.testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABC...";

import { formatSSE, heartbeatComment, toStreamEvent } from "../src/services/marketEventsStream";
import type { IndexerEvent } from "../src/db/schema";

describe("toStreamEvent", () => {
  it("converts a DB row to a StreamEvent", () => {
    const row: IndexerEvent = {
      id: "42",
      marketId: "mkt-1",
      eventType: "prediction",
      data: { outcome: "yes", amount: "100" },
      ledger: 12345,
      txHash: "mock-tx-hash",
      opIndex: 0,
      createdAt: new Date("2025-06-01T12:00:00Z"),
    };
    const result = toStreamEvent(row);
    expect(result.id).toBe("42");
    expect(result.eventType).toBe("prediction");
    expect(result.data).toEqual({ outcome: "yes", amount: "100" });
    expect(result.createdAt).toBe("2025-06-01T12:00:00.000Z");
  });

  it("handles null data field", () => {
    const row: IndexerEvent = {
      id: "1",
      marketId: "mkt-1",
      eventType: "resolved",
      data: null,
      ledger: 100,
      txHash: "mock-tx-hash",
      opIndex: 0,
      createdAt: new Date("2025-06-01T12:00:00Z"),
    };
    const result = toStreamEvent(row);
    expect(result.data).toEqual({});
  });
});

describe("formatSSE", () => {
  it("formats a correctly structured SSE message", () => {
    const event = {
      id: "42",
      eventType: "prediction",
      data: { outcome: "yes" },
      createdAt: "2025-06-01T12:00:00Z",
    };
    const msg = formatSSE(event);
    expect(msg).toContain("id: 42");
    expect(msg).toContain("event: prediction");
    expect(msg).toContain('data: {"outcome":"yes"}');
    expect(msg).toMatch(/\n\n$/);
  });
});

describe("heartbeatComment", () => {
  it("produces a keepalive comment line", () => {
    expect(heartbeatComment()).toBe(": heartbeat\n\n");
  });
});
