/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "qrs-test-secret-at-least-32-bytes-long!!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

const mockInsert = jest.fn();
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
const mockReturning = jest.fn();

jest.mock("../src/db/client", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
  },
  pool: { on: jest.fn(), end: jest.fn() },
}));

import {
  createQuotaRequest,
  getQuotaRequestsByUser,
  getPendingCountByUser,
  VALID_QUOTA_TYPES,
} from "../src/services/quotaRequestService";

const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_UUID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = new Date("2025-01-01T00:00:00.000Z");

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_UUID,
    userId: TEST_USER_ID,
    quotaType: "prediction_limit",
    requestedValue: 100,
    reason: "I need to make more predictions for testing.",
    status: "pending",
    reviewedBy: null,
    reviewNotes: null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function expectedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_UUID,
    userId: TEST_USER_ID,
    quotaType: "prediction_limit",
    requestedValue: 100,
    reason: "I need to make more predictions for testing.",
    status: "pending",
    reviewedBy: null,
    reviewNotes: null,
    reviewedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInsert.mockReturnValue({ values: jest.fn().mockReturnThis(), returning: mockReturning });
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit });
  mockOrderBy.mockReturnValue({});
  mockLimit.mockResolvedValue([]);
  mockReturning.mockResolvedValue([]);
});

describe("createQuotaRequest", () => {
  const validInput = {
    userId: TEST_USER_ID,
    quotaType: "prediction_limit",
    requestedValue: 100,
    reason: "I need to make more predictions for testing.",
  };

  it("returns validation error for invalid quotaType", async () => {
    const result = await createQuotaRequest({ ...validInput, quotaType: "invalid_type" as any });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("ValidationError");
    }
  });

  it("returns validation error for requestedValue < 1", async () => {
    const result = await createQuotaRequest({ ...validInput, requestedValue: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("ValidationError");
    }
  });

  it("returns validation error for reason shorter than 10 chars", async () => {
    const result = await createQuotaRequest({ ...validInput, reason: "short" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("ValidationError");
    }
  });

  it("returns validation error for reason longer than 1000 chars", async () => {
    const result = await createQuotaRequest({ ...validInput, reason: "x".repeat(1001) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("ValidationError");
    }
  });

  it("accepts all valid quota types", async () => {
    mockReturning.mockResolvedValue([dbRow()]);
    for (const qt of VALID_QUOTA_TYPES) {
      mockReturning.mockResolvedValueOnce([dbRow({ quotaType: qt })]);
      const result = await createQuotaRequest({ ...validInput, quotaType: qt });
      expect(result.ok).toBe(true);
    }
  });

  it("returns ok with row on successful insert", async () => {
    mockReturning.mockResolvedValue([dbRow()]);

    const result = await createQuotaRequest(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(expectedRow());
    }
  });

  it("trims the reason before inserting", async () => {
    mockReturning.mockResolvedValue([dbRow({ reason: "I need to make more predictions." })]);

    const result = await createQuotaRequest({
      ...validInput,
      reason: "  I need to make more predictions.  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reason).toBe("I need to make more predictions.");
    }
  });

  it("calls insert with correct values", async () => {
    mockReturning.mockResolvedValue([dbRow()]);

    await createQuotaRequest(validInput);

    expect(mockInsert).toHaveBeenCalled();
    const insertArg = (mockInsert as jest.Mock).mock.calls[0][0];
    expect(insertArg).toBeDefined();
  });

  it("returns internal error when DB throws", async () => {
    mockReturning.mockRejectedValue(new Error("connection failed"));

    const result = await createQuotaRequest(validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("InternalError");
    }
  });

  it("returns validation error when requestedValue is negative", async () => {
    const result = await createQuotaRequest({ ...validInput, requestedValue: -5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("ValidationError");
    }
  });
});

describe("getQuotaRequestsByUser", () => {
  it("returns empty array when user has no requests", async () => {
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([]);

    const result = await getQuotaRequestsByUser(TEST_USER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it("returns rows mapped to QuotaRequestRow format", async () => {
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([dbRow()]);

    const result = await getQuotaRequestsByUser(TEST_USER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(TEST_UUID);
      expect(result.value[0].createdAt).toBe("2025-01-01T00:00:00.000Z");
    }
  });

  it("includes null review fields when not reviewed", async () => {
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([dbRow()]);

    const result = await getQuotaRequestsByUser(TEST_USER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].reviewedBy).toBeNull();
      expect(result.value[0].reviewNotes).toBeNull();
      expect(result.value[0].reviewedAt).toBeNull();
    }
  });

  it("includes review fields when reviewed", async () => {
    const reviewedAt = new Date("2025-02-01T00:00:00.000Z");
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([
      dbRow({
        reviewedBy: "admin-address",
        reviewNotes: "Approved",
        reviewedAt,
      }),
    ]);

    const result = await getQuotaRequestsByUser(TEST_USER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].reviewedBy).toBe("admin-address");
      expect(result.value[0].reviewNotes).toBe("Approved");
      expect(result.value[0].reviewedAt).toBe("2025-02-01T00:00:00.000Z");
    }
  });

  it("returns internal error when DB throws", async () => {
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockRejectedValue(new Error("db down"));

    const result = await getQuotaRequestsByUser(TEST_USER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("InternalError");
    }
  });
});

describe("getPendingCountByUser", () => {
  beforeEach(() => {
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
  });

  it("returns 0 when there are no pending requests", async () => {
    mockWhere.mockResolvedValue([{ value: 0 }]);

    const count = await getPendingCountByUser(TEST_USER_ID);
    expect(count).toBe(0);
  });

  it("returns the count of pending requests", async () => {
    mockWhere.mockResolvedValue([{ value: 3 }]);

    const count = await getPendingCountByUser(TEST_USER_ID);
    expect(count).toBe(3);
  });

  it("handles undefined row gracefully", async () => {
    mockWhere.mockResolvedValue([]);

    const count = await getPendingCountByUser(TEST_USER_ID);
    expect(count).toBe(0);
  });
});
