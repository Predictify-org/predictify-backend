import { getAuditLogs } from "../src/repositories/auditLogRepo";
import { db } from "../src/db";

// ── DB Mock ──────────────────────────────────────────────────────────────────

jest.mock("../src/db", () => {
  const queryChain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(),
  };
  return {
    db: queryChain,
  };
});

const mockDb = db as any;

describe("auditLogRepo", () => {
  const mockLimit = mockDb.limit as jest.Mock;
  const mockWhere = mockDb.where as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("handles empty filters and returns paginated result", async () => {
    const mockRows = [
      {
        id: "1",
        action: "action1",
        walletAddress: "G1",
        ip: "127.0.0.1",
        correlationId: "c1",
        rateLimitContext: null,
        createdAt: new Date("2026-06-27T12:00:00Z"),
      },
    ];
    mockLimit.mockResolvedValue(mockRows);

    const result = await getAuditLogs({});

    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.from).toHaveBeenCalled();
    expect(mockDb.orderBy).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(21); // DEFAULT_PAGE_SIZE (20) + 1
    expect(mockWhere).toHaveBeenCalledWith(undefined);

    expect(result.data).toEqual(mockRows);
    expect(result.nextCursor).toBeNull();
  });

  it("applies filtering by action, actor, and dates", async () => {
    mockLimit.mockResolvedValue([]);

    const startDate = new Date("2026-06-27T00:00:00Z");
    const endDate = new Date("2026-06-27T23:59:59Z");

    await getAuditLogs({
      action: "market.create",
      actor: "GADMIN",
      startDate,
      endDate,
    });

    expect(mockWhere).toHaveBeenCalledWith(expect.anything());
    // Verification of filters being appended
    const lastWhereCallArgs = mockWhere.mock.calls[0][0];
    expect(lastWhereCallArgs).toBeDefined();
  });

  it("generates nextCursor when hasMore is true", async () => {
    const mockRows = [
      {
        id: "1",
        action: "action1",
        walletAddress: "G1",
        ip: "127.0.0.1",
        correlationId: "c1",
        rateLimitContext: null,
        createdAt: new Date("2026-06-27T12:00:00Z"),
      },
      {
        id: "2",
        action: "action2",
        walletAddress: "G2",
        ip: "127.0.0.1",
        correlationId: "c2",
        rateLimitContext: null,
        createdAt: new Date("2026-06-27T11:00:00Z"),
      },
    ];
    // limit 1, returning 2 rows (hasMore = true)
    mockLimit.mockResolvedValue(mockRows);

    const result = await getAuditLogs({ limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("1");
    expect(result.nextCursor).not.toBeNull();
  });
});
