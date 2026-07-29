/**
 * webhookCatalog.test.ts
 *
 * Focused unit tests for src/services/webhookCatalog.ts.
 *
 * Coverage
 * ────────
 *  1. isKnownEventType  — recognises all registered types; rejects unknowns.
 *  2. validatePayload   — passes valid shapes; throws ZodError on bad data.
 *  3. buildPayload      — stamps envelope, validates, returns typed payload.
 *  4. Catalog invariants — ALL_EVENT_TYPES matches WEBHOOK_EVENT_SCHEMAS keys.
 *  5. Edge cases        — nullable evidenceUri, wildcard not in catalog, etc.
 */

import { ZodError } from "zod";
import {
  isKnownEventType,
  validatePayload,
  buildPayload,
  ALL_EVENT_TYPES,
  WEBHOOK_EVENT_SCHEMAS,
  MarketResolvedPayloadSchema,
  DisputeOpenedPayloadSchema,
} from "../src/services/webhookCatalog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fully-valid market.resolved payload object. */
function validMarketResolved() {
  return {
    event: "market.resolved" as const,
    id: "00000000-0000-4000-a000-000000000001",
    timestamp: new Date().toISOString(),
    marketId: "mkt-abc",
    winningOutcome: "yes",
    ledger: 5_000_000,
    onChainTimestamp: 1_700_000_000,
  };
}

/** Returns a fully-valid dispute.opened payload object. */
function validDisputeOpened() {
  return {
    event: "dispute.opened" as const,
    id: "00000000-0000-4000-a000-000000000002",
    timestamp: new Date().toISOString(),
    marketId: "mkt-abc",
    disputeId: "00000000-0000-4000-a000-000000000003",
    openedBy: "00000000-0000-4000-a000-000000000004",
    reason: "Incorrect resolution",
    evidenceUri: null,
  };
}

// ---------------------------------------------------------------------------
// 1. isKnownEventType
// ---------------------------------------------------------------------------

describe("isKnownEventType", () => {
  it("returns true for every registered event type", () => {
    for (const et of ALL_EVENT_TYPES) {
      expect(isKnownEventType(et)).toBe(true);
    }
  });

  it("returns true for 'market.resolved'", () => {
    expect(isKnownEventType("market.resolved")).toBe(true);
  });

  it("returns true for 'dispute.opened'", () => {
    expect(isKnownEventType("dispute.opened")).toBe(true);
  });

  it("returns false for unknown event types", () => {
    expect(isKnownEventType("user.created")).toBe(false);
    expect(isKnownEventType("")).toBe(false);
    expect(isKnownEventType("*")).toBe(false);
    expect(isKnownEventType("MARKET.RESOLVED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. validatePayload
// ---------------------------------------------------------------------------

describe("validatePayload — market.resolved", () => {
  it("accepts a fully-valid payload", () => {
    const payload = validMarketResolved();
    const result = validatePayload("market.resolved", payload);
    expect(result.event).toBe("market.resolved");
    expect(result.marketId).toBe("mkt-abc");
  });

  it("throws ZodError when marketId is missing", () => {
    const payload = { ...validMarketResolved(), marketId: undefined };
    expect(() => validatePayload("market.resolved", payload)).toThrow(ZodError);
  });

  it("throws ZodError when ledger is a float", () => {
    const payload = { ...validMarketResolved(), ledger: 1.5 };
    expect(() => validatePayload("market.resolved", payload)).toThrow(ZodError);
  });

  it("throws ZodError when ledger is negative", () => {
    const payload = { ...validMarketResolved(), ledger: -1 };
    expect(() => validatePayload("market.resolved", payload)).toThrow(ZodError);
  });

  it("throws ZodError when event literal is wrong", () => {
    const payload = { ...validMarketResolved(), event: "dispute.opened" };
    expect(() => validatePayload("market.resolved", payload)).toThrow(ZodError);
  });

  it("throws ZodError when timestamp is not ISO 8601", () => {
    const payload = { ...validMarketResolved(), timestamp: "not-a-date" };
    expect(() => validatePayload("market.resolved", payload)).toThrow(ZodError);
  });

  it("throws ZodError when id is not a UUID", () => {
    const payload = { ...validMarketResolved(), id: "not-a-uuid" };
    expect(() => validatePayload("market.resolved", payload)).toThrow(ZodError);
  });
});

describe("validatePayload — dispute.opened", () => {
  it("accepts a fully-valid payload with null evidenceUri", () => {
    const payload = validDisputeOpened();
    const result = validatePayload("dispute.opened", payload);
    expect(result.event).toBe("dispute.opened");
    expect((result as typeof payload).evidenceUri).toBeNull();
  });

  it("accepts a valid payload with a proper evidenceUri URL", () => {
    const payload = { ...validDisputeOpened(), evidenceUri: "https://evidence.example.com/doc.pdf" };
    const result = validatePayload("dispute.opened", payload);
    expect((result as typeof payload).evidenceUri).toBe("https://evidence.example.com/doc.pdf");
  });

  it("accepts a payload when evidenceUri is omitted entirely", () => {
    const { evidenceUri: _omit, ...payload } = validDisputeOpened();
    const result = validatePayload("dispute.opened", payload);
    expect(result).toBeTruthy();
  });

  it("throws ZodError when evidenceUri is a non-URL string", () => {
    const payload = { ...validDisputeOpened(), evidenceUri: "not-a-url" };
    expect(() => validatePayload("dispute.opened", payload)).toThrow(ZodError);
  });

  it("throws ZodError when openedBy is not a UUID", () => {
    const payload = { ...validDisputeOpened(), openedBy: "some-user" };
    expect(() => validatePayload("dispute.opened", payload)).toThrow(ZodError);
  });

  it("throws ZodError when reason is missing", () => {
    const payload = { ...validDisputeOpened(), reason: undefined };
    expect(() => validatePayload("dispute.opened", payload)).toThrow(ZodError);
  });

  it("throws ZodError when disputeId is not a UUID", () => {
    const payload = { ...validDisputeOpened(), disputeId: "bad-id" };
    expect(() => validatePayload("dispute.opened", payload)).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// 3. buildPayload
// ---------------------------------------------------------------------------

describe("buildPayload — market.resolved", () => {
  it("stamps envelope fields automatically", () => {
    const payload = buildPayload("market.resolved", {
      marketId: "mkt-1",
      winningOutcome: "no",
      ledger: 1_000_000,
      onChainTimestamp: 1_700_000_000,
    });

    expect(payload.event).toBe("market.resolved");
    expect(payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.marketId).toBe("mkt-1");
    expect(payload.winningOutcome).toBe("no");
    expect(payload.ledger).toBe(1_000_000);
  });

  it("generates a unique id on every call", () => {
    const a = buildPayload("market.resolved", { marketId: "m", winningOutcome: "yes", ledger: 1, onChainTimestamp: 1 });
    const b = buildPayload("market.resolved", { marketId: "m", winningOutcome: "yes", ledger: 1, onChainTimestamp: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it("throws ZodError when required data fields are missing", () => {
    expect(() =>
      // @ts-expect-error intentionally omitting required fields for test
      buildPayload("market.resolved", { marketId: "m" }),
    ).toThrow(ZodError);
  });
});

describe("buildPayload — dispute.opened", () => {
  it("stamps envelope fields and accepts null evidenceUri", () => {
    const payload = buildPayload("dispute.opened", {
      marketId: "mkt-2",
      disputeId: "00000000-0000-4000-a000-000000000010",
      openedBy: "00000000-0000-4000-a000-000000000011",
      reason: "Wrong outcome declared",
      evidenceUri: null,
    });

    expect(payload.event).toBe("dispute.opened");
    expect(payload.marketId).toBe("mkt-2");
    expect(payload.reason).toBe("Wrong outcome declared");
  });

  it("accepts a valid evidenceUri", () => {
    const payload = buildPayload("dispute.opened", {
      marketId: "mkt-3",
      disputeId: "00000000-0000-4000-a000-000000000020",
      openedBy: "00000000-0000-4000-a000-000000000021",
      reason: "Evidence attached",
      evidenceUri: "https://example.com/evidence.png",
    });

    expect(payload.evidenceUri).toBe("https://example.com/evidence.png");
  });
});

// ---------------------------------------------------------------------------
// 4. Catalog invariants
// ---------------------------------------------------------------------------

describe("WEBHOOK_EVENT_SCHEMAS catalog invariants", () => {
  it("ALL_EVENT_TYPES contains every key in WEBHOOK_EVENT_SCHEMAS", () => {
    const schemaKeys = Object.keys(WEBHOOK_EVENT_SCHEMAS).sort();
    const typeKeys = [...ALL_EVENT_TYPES].sort();
    expect(typeKeys).toEqual(schemaKeys);
  });

  it("has at least 2 registered event types", () => {
    expect(ALL_EVENT_TYPES.length).toBeGreaterThanOrEqual(2);
  });

  it("every schema has an 'event' field and a 'timestamp' field", () => {
    for (const schema of Object.values(WEBHOOK_EVENT_SCHEMAS)) {
      expect(schema.shape).toHaveProperty("event");
      expect(schema.shape).toHaveProperty("timestamp");
      expect(schema.shape).toHaveProperty("id");
    }
  });

  it("wildcard '*' is not in the catalog (it is a subscription filter, not an event)", () => {
    expect(isKnownEventType("*")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Schema shape checks
// ---------------------------------------------------------------------------

describe("MarketResolvedPayloadSchema shape", () => {
  it("contains all documented fields", () => {
    const shape = MarketResolvedPayloadSchema.shape;
    expect(shape).toHaveProperty("marketId");
    expect(shape).toHaveProperty("winningOutcome");
    expect(shape).toHaveProperty("ledger");
    expect(shape).toHaveProperty("onChainTimestamp");
  });
});

describe("DisputeOpenedPayloadSchema shape", () => {
  it("contains all documented fields", () => {
    const shape = DisputeOpenedPayloadSchema.shape;
    expect(shape).toHaveProperty("marketId");
    expect(shape).toHaveProperty("disputeId");
    expect(shape).toHaveProperty("openedBy");
    expect(shape).toHaveProperty("reason");
    expect(shape).toHaveProperty("evidenceUri");
  });
});
