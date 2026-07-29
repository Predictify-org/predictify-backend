import { getUserStats, clearUserStatsCache } from "../src/services/userStatsService";

const select = jest.fn();

jest.mock("../src/db/client", () => ({
  getDb: () => ({ select }),
}));

const ADDRESS = `G${"A".repeat(55)}`;

function selectReturning(rows: unknown[], needsLimit = false) {
  return {
    from: jest.fn(() => ({
      where: jest.fn(() =>
        needsLimit
          ? { limit: jest.fn(async () => rows) }
          : Promise.resolve(rows),
      ),
    })),
  };
}

describe("getUserStats", () => {
  beforeEach(() => {
    clearUserStatsCache();
    select.mockReset();
  });

  it("aggregates predictions by status and computes win rate", async () => {
    select
      .mockReturnValueOnce(selectReturning([{ id: "user-1", stellarAddress: ADDRESS }], true))
      .mockReturnValueOnce(selectReturning([
        { id: "p1", marketId: "mkt-1", amount: "100", status: "won" },
        { id: "p2", marketId: "mkt-1", amount: "50",  status: "lost" },
        { id: "p3", marketId: "mkt-2", amount: "25",  status: "pending" },
        { id: "p4", marketId: "mkt-3", amount: "75",  status: "confirmed" },
        { id: "p5", marketId: "mkt-3", amount: "10",  status: "claimed" },
      ]))
      .mockReturnValueOnce(selectReturning([{ amount: "200" }]));

    const stats = await getUserStats(ADDRESS);

    expect(stats).not.toBeNull();
    expect(stats!.totalPredictions).toBe(5);
    expect(stats!.totalStaked).toBe("260");
    expect(stats!.marketsParticipated).toBe(3);
    expect(stats!.totalClaimed).toBe("200");
    expect(stats!.byStatus).toEqual({ won: 1, lost: 1, pending: 1, confirmed: 1, claimed: 1 });
    expect(stats!.winRate).toBe(0.5);
  });

  it("returns winRate 0 when no resolved predictions", async () => {
    select
      .mockReturnValueOnce(selectReturning([{ id: "user-1", stellarAddress: ADDRESS }], true))
      .mockReturnValueOnce(selectReturning([
        { id: "p1", marketId: "mkt-1", amount: "10", status: "pending" },
        { id: "p2", marketId: "mkt-1", amount: "20", status: "pending" },
      ]))
      .mockReturnValueOnce(selectReturning([]));

    const stats = await getUserStats(ADDRESS);

    expect(stats!.winRate).toBe(0);
    expect(stats!.totalStaked).toBe("30");
  });

  it("returns winRate 1 when all won", async () => {
    select
      .mockReturnValueOnce(selectReturning([{ id: "user-1", stellarAddress: ADDRESS }], true))
      .mockReturnValueOnce(selectReturning([
        { id: "p1", marketId: "mkt-1", amount: "100", status: "won" },
        { id: "p2", marketId: "mkt-2", amount: "50",  status: "won" },
      ]))
      .mockReturnValueOnce(selectReturning([]));

    const stats = await getUserStats(ADDRESS);

    expect(stats!.winRate).toBe(1);
    expect(stats!.byStatus).toEqual({ won: 2, lost: 0, pending: 0, confirmed: 0, claimed: 0 });
  });

  it("returns null for unknown address", async () => {
    select
      .mockReturnValueOnce(selectReturning([], true));

    const stats = await getUserStats(ADDRESS);

    expect(stats).toBeNull();
  });

  it("uses the short-lived cache for repeated reads", async () => {
    select
      .mockReturnValueOnce(selectReturning([{ id: "user-1", stellarAddress: ADDRESS }], true))
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([]));

    await getUserStats(ADDRESS);
    await getUserStats(ADDRESS);

    expect(select).toHaveBeenCalledTimes(3);
  });
});
