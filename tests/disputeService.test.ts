jest.mock("../src/db/client", () => {
  const mockDb = {
    query: {
      markets: { findFirst: jest.fn() },
      predictions: { findFirst: jest.fn() },
      disputes: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
  };
  return { db: mockDb };
});

jest.mock("../src/services/webhookService", () => ({
  emitWebhook: jest.fn(),
}));

import { db } from "../src/db/client";
import { openDispute, DisputeError } from "../src/services/disputeService";
import { emitWebhook } from "../src/services/webhookService";

const mockDb = db as unknown as {
  query: {
    markets: { findFirst: jest.Mock };
    predictions: { findFirst: jest.Mock };
    disputes: { findFirst: jest.Mock };
  };
  insert: jest.Mock;
  update: jest.Mock;
};

const mockEmitWebhook = emitWebhook as jest.Mock;

const VALID_INPUT = {
  marketId: "market-1",
  userId: "550e8400-e29b-41d4-a716-446655440000",
  reason: "The outcome is incorrect because the oracle data was manipulated.",
};

function mockInsertReturn(data: Record<string, unknown>) {
  mockDb.insert.mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([data]),
    }),
  });
}

function mockUpdateReturn() {
  mockDb.update.mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  });
}

describe("openDispute service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws 404 when market is not found", async () => {
    mockDb.query.markets.findFirst.mockResolvedValue(null);

    await expect(openDispute(VALID_INPUT)).rejects.toThrow(DisputeError);
    await expect(openDispute(VALID_INPUT)).rejects.toMatchObject({
      status: 404,
      code: "market_not_found",
    });
  });

  it("throws 403 when caller has no prediction in the market", async () => {
    mockDb.query.markets.findFirst.mockResolvedValue({ id: "market-1" });
    mockDb.query.predictions.findFirst.mockResolvedValue(null);

    await expect(openDispute(VALID_INPUT)).rejects.toMatchObject({
      status: 403,
      code: "no_prediction",
    });
  });

  it("throws 409 when a prior open dispute exists", async () => {
    mockDb.query.markets.findFirst.mockResolvedValue({ id: "market-1" });
    mockDb.query.predictions.findFirst.mockResolvedValue({ id: "pred-1" });
    mockDb.query.disputes.findFirst.mockResolvedValue({ id: "disc-1", status: "open" });

    await expect(openDispute(VALID_INPUT)).rejects.toMatchObject({
      status: 409,
      code: "duplicate_dispute",
    });
  });

  it("inserts dispute, updates market, and emits webhook on success", async () => {
    mockDb.query.markets.findFirst.mockResolvedValue({ id: "market-1", status: "active" });
    mockDb.query.predictions.findFirst.mockResolvedValue({ id: "pred-1" });
    mockDb.query.disputes.findFirst.mockResolvedValue(null);

    const fakeDispute = {
      id: "disc-123",
      marketId: "market-1",
      openedBy: VALID_INPUT.userId,
      reason: VALID_INPUT.reason,
      evidenceUri: null,
      status: "open",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    };
    mockInsertReturn(fakeDispute);
    mockUpdateReturn();

    const result = await openDispute(VALID_INPUT);

    expect(result).toEqual(fakeDispute);
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockEmitWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispute.opened",
        marketId: "market-1",
        disputeId: "disc-123",
        reason: VALID_INPUT.reason,
      }),
    );
  });

  it("passes evidenceUri when provided", async () => {
    mockDb.query.markets.findFirst.mockResolvedValue({ id: "market-1", status: "active" });
    mockDb.query.predictions.findFirst.mockResolvedValue({ id: "pred-1" });
    mockDb.query.disputes.findFirst.mockResolvedValue(null);

    const fakeDispute = {
      id: "disc-456",
      marketId: "market-1",
      openedBy: VALID_INPUT.userId,
      reason: VALID_INPUT.reason,
      evidenceUri: "https://example.com/evidence",
      status: "open",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    };
    mockInsertReturn(fakeDispute);
    mockUpdateReturn();

    const result = await openDispute({ ...VALID_INPUT, evidenceUri: "https://example.com/evidence" });

    expect(result.evidenceUri).toBe("https://example.com/evidence");
    expect(mockEmitWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceUri: "https://example.com/evidence" }),
    );
  });
});
