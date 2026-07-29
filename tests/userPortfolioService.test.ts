import { getUserPortfolio, clearUserPortfolioCache } from "../src/services/userPortfolioService";

const select = jest.fn();

jest.mock("../src/db/client", () => ({
  getDb: () => ({ select }),
}));

const ADDRESS = `G${"A".repeat(55)}`;

function selectReturning(rows: unknown[], needsLimit = false) {
  return {
    from: jest.fn(() => ({
      where: jest.fn(() => needsLimit ? { limit: jest.fn(async () => rows) } : Promise.resolve(rows)),
      innerJoin: jest.fn(() => ({
        where: jest.fn(async () => rows),
      })),
    })),
  };
}

describe("getUserPortfolio", () => {
  beforeEach(() => {
    clearUserPortfolioCache();
    select.mockReset();
  });

  it("aggregates predictions and pending claims by market", async () => {
    select
      .mockReturnValueOnce(selectReturning([{ id: "user-1", stellarAddress: ADDRESS }], true))
      .mockReturnValueOnce(selectReturning([
        {
          id: "prediction-1",
          marketId: "market-1",
          question: "Will it ship?",
          marketStatus: "resolved",
          resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
          outcome: "yes",
          amount: "100",
          status: "won",
          createdAt: new Date("2026-06-28T00:00:00.000Z"),
        },
        {
          id: "prediction-2",
          marketId: "market-1",
          question: "Will it ship?",
          marketStatus: "resolved",
          resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
          outcome: "yes",
          amount: "25",
          status: "confirmed",
          createdAt: new Date("2026-06-29T00:00:00.000Z"),
        },
      ]))
      .mockReturnValueOnce(selectReturning([{ marketId: "market-1", amount: "50" }]));

    const portfolio = await getUserPortfolio(ADDRESS);

    expect(portfolio?.totals).toEqual({
      marketCount: 1,
      predictionCount: 2,
      totalStaked: "125",
      claimableAmount: "50",
      won: 1,
      lost: 0,
      pending: 0,
      confirmed: 1,
      claimed: 0,
    });
    expect(portfolio?.markets).toEqual([
      expect.objectContaining({
        marketId: "market-1",
        predictionCount: 2,
        totalStaked: "125",
        claimableAmount: "50",
        latestPredictionAt: "2026-06-29T00:00:00.000Z",
      }),
    ]);
  });

  it("uses the short-lived cache for repeated reads", async () => {
    select
      .mockReturnValueOnce(selectReturning([{ id: "user-1", stellarAddress: ADDRESS }], true))
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([]));

    await getUserPortfolio(ADDRESS);
    await getUserPortfolio(ADDRESS);

    expect(select).toHaveBeenCalledTimes(3);
  });
});
