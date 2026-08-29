/**
 * Unit tests for referral reward allocation idempotency.
 *
 * This test suite validates that allocateReferralReward implements strict
 * idempotent semantics:
 * - First allocation succeeds and is persisted durably.
 * - Exact retry with same idempotency key returns the stored allocation.
 * - Retry with different reward parameters is rejected with explicit conflict.
 * - Concurrent/race inserts on the same referral or key are serialized safely.
 * - Validation errors are consistent and safe to expose to clients.
 *
 * All database access is mocked so no real state is modified.
 */

// ── Environment stubs (must be set before any module import) ─────────────────
process.env.JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-000000";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ── Mock pg and drizzle before any imports ─────────────────────────────────
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({})),
}));

// ── Mock db.client with controllable mock ─────────────────────────────────

let mockDb: any = {};

jest.mock("../src/db/client", () => ({
  get db() {
    return mockDb;
  },
}));

import {
  allocateReferralReward,
  ReferralRewardValidationError,
  ReferralRewardConflictError,
  type AllocateReferralRewardInput,
} from "../src/services/referralService";
import type { ReferralRewardAllocation } from "../src/db/schema";

// ── Test fixtures ────────────────────────────────────────────────────────────

const VALID_REFERRAL_ID = "00000000-0000-0000-0000-000000000001";
const VALID_IDEMPOTENCY_KEY = "req-2026-08-29-001";
const VALID_AMOUNT = "100.5";
const VALID_ASSET = "USDC";

function makeAllocation(overrides: Partial<ReferralRewardAllocation> = {}): ReferralRewardAllocation {
  return {
    id: "00000000-0000-0000-0000-000000000100",
    referralId: VALID_REFERRAL_ID,
    idempotencyKey: VALID_IDEMPOTENCY_KEY,
    amount: VALID_AMOUNT,
    asset: VALID_ASSET,
    createdAt: new Date("2026-08-29T12:00:00.000Z"),
    ...overrides,
  };
}

function makeMockInsert() {
  return {
    values: jest.fn(function () {
      return {
        onConflictDoNothing: jest.fn(function () {
          return {
            returning: jest.fn(),
          };
        }),
      };
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("allocateReferralReward - Validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects empty referralId", async () => {
    await expect(
      allocateReferralReward({
        referralId: "",
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("rejects whitespace-only referralId", async () => {
    await expect(
      allocateReferralReward({
        referralId: "  ",
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("rejects empty idempotencyKey", async () => {
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: "",
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("rejects idempotencyKey exceeding 128 characters", async () => {
    const longKey = "k".repeat(129);
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: longKey,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("accepts idempotencyKey at exactly 128 characters", async () => {
    const key128 = "k".repeat(128);
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [makeAllocation({ idempotencyKey: key128 })]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: key128,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(result.idempotencyKey).toBe(key128);
  });

  it("rejects negative amount", async () => {
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: "-100.5",
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("rejects zero amount", async () => {
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: "0",
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("rejects amount with too many decimal places (> 18)", async () => {
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: "100.123456789012345678901",
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("accepts amount with exactly 18 decimal places", async () => {
    const amount = "100.123456789012345678";
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [makeAllocation({ amount })]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount,
      asset: VALID_ASSET,
    });

    expect(result.amount).toBe(amount);
  });

  it("accepts whole number without decimal point", async () => {
    const amount = "100";
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [makeAllocation({ amount })]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount,
      asset: VALID_ASSET,
    });

    expect(result.amount).toBe(amount);
  });

  it("rejects asset with lowercase letters", async () => {
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: "usdc",
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("rejects asset exceeding 12 characters", async () => {
    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: "A".repeat(13),
      }),
    ).rejects.toThrow(ReferralRewardValidationError);
  });

  it("accepts asset with exactly 12 characters", async () => {
    const asset = "A".repeat(12);
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [makeAllocation({ asset })]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset,
    });

    expect(result.asset).toBe(asset);
  });

  it("accepts numeric-only asset", async () => {
    const asset = "0123456789";
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [makeAllocation({ asset })]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset,
    });

    expect(result.asset).toBe(asset);
  });
});

describe("allocateReferralReward - First allocation (no conflict)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("succeeds and returns the inserted allocation", async () => {
    const allocation = makeAllocation();
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [allocation]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(result).toEqual(allocation);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("passes correct values to database insert", async () => {
    const allocation = makeAllocation();
    const mockValues = jest.fn(() => ({
      onConflictDoNothing: jest.fn(() => ({
        returning: jest.fn(async () => [allocation]),
      })),
    }));
    mockDb.insert = jest.fn(() => ({ values: mockValues }));

    await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(mockValues).toHaveBeenCalledWith({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });
  });
});

describe("allocateReferralReward - Exact retry (idempotency)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns existing allocation when idempotency key matches", async () => {
    const allocation = makeAllocation();
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []), // insert returns nothing (conflict)
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [allocation]),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(result).toEqual(allocation);
  });

  it("queries by idempotency key first when insert fails", async () => {
    const allocation = makeAllocation();
    const mockSelect = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [allocation]),
      })),
    }));
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = mockSelect;

    await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(mockSelect).toHaveBeenCalled();
  });
});

describe("allocateReferralReward - Mismatch detection (safety)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects when idempotency key exists but referralId differs", async () => {
    const stored = makeAllocation({
      referralId: "different-referral-id",
    });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [stored]),
      })),
    }));

    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardConflictError);
  });

  it("rejects when idempotency key exists but amount differs", async () => {
    const stored = makeAllocation({
      amount: "999.99",
    });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [stored]),
      })),
    }));

    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardConflictError);
  });

  it("rejects when idempotency key exists but asset differs", async () => {
    const stored = makeAllocation({
      asset: "NATIVE",
    });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [stored]),
      })),
    }));

    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow(ReferralRewardConflictError);
  });

  it("error message does not expose internal state", async () => {
    const stored = makeAllocation({ amount: "999.99" });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [stored]),
      })),
    }));

    try {
      await allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      });
      fail("Expected error to be thrown");
    } catch (error: any) {
      expect(error.code).toBe("referral_reward_conflict");
      expect(error.message).not.toContain("999.99"); // should not leak stored value
      expect(error.message).not.toContain(VALID_AMOUNT); // should not leak request value
    }
  });
});

describe("allocateReferralReward - Referral uniqueness (no double pay)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns existing allocation when referral has allocation with different key but same reward params", async () => {
    const existing = makeAllocation({
      idempotencyKey: "req-2026-08-29-old",
    });
    let selectCallCount = 0;
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => {
          selectCallCount++;
          // First call is by key (returns nothing), second call is by referral
          return selectCallCount === 1 ? [] : [existing];
        }),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: "req-2026-08-29-new", // different key
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    // Returns the existing allocation even with different key, because referral is already allocated
    expect(result).toEqual(existing);
  });

  it("allows same referral + same key (idempotent retry)", async () => {
    const allocation = makeAllocation();
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => [allocation]),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(result).toEqual(allocation);
  });
});

describe("allocateReferralReward - Boundary cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("handles very large amount", async () => {
    const largeAmount = "999999999999999999.999999999999999999";
    const allocation = makeAllocation({ amount: largeAmount });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [allocation]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: largeAmount,
      asset: VALID_ASSET,
    });

    expect(result.amount).toBe(largeAmount);
  });

  it("handles minimum positive amount (0.000000000000000001)", async () => {
    const minAmount = "0.000000000000000001";
    const allocation = makeAllocation({ amount: minAmount });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [allocation]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: minAmount,
      asset: VALID_ASSET,
    });

    expect(result.amount).toBe(minAmount);
  });

  it("handles single-character asset", async () => {
    const asset = "X";
    const allocation = makeAllocation({ asset });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [allocation]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
      amount: VALID_AMOUNT,
      asset,
    });

    expect(result.asset).toBe(asset);
  });

  it("handles key at minimum length (1 character)", async () => {
    const key = "k";
    const allocation = makeAllocation({ idempotencyKey: key });
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => [allocation]),
        })),
      })),
    }));

    const result = await allocateReferralReward({
      referralId: VALID_REFERRAL_ID,
      idempotencyKey: key,
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
    });

    expect(result.idempotencyKey).toBe(key);
  });
});

describe("allocateReferralReward - Error cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws generic error if neither key nor referral lookup resolves", async () => {
    mockDb.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(async () => []),
        })),
      })),
    }));
    mockDb.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => []),
      })),
    }));

    await expect(
      allocateReferralReward({
        referralId: VALID_REFERRAL_ID,
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    ).rejects.toThrow("referral reward allocation conflict could not be resolved");
  });
});
