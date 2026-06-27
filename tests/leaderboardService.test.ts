const executeMock = jest.fn();

jest.mock("../src/db", () => ({
  db: {
    execute: executeMock,
  },
}));

import {
  clearLeaderboardCacheForTests,
  getLeaderboard,
  getLeaderboardWithRefresh,
  getUserLeaderboardEntry,
} from "../src/services/leaderboardService";

function queryHasIdentifier(query: unknown, identifier: string): boolean {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.some((chunk) => (chunk as { value?: unknown }).value === identifier);
}

describe("leaderboardService period views", () => {
  beforeEach(() => {
    executeMock.mockReset();
    clearLeaderboardCacheForTests();
  });

  it("reads the materialized view for the requested period", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await getLeaderboard("weekly", 25, 5);

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(queryHasIdentifier(executeMock.mock.calls[0][0], "leaderboard_weekly_mv")).toBe(true);
  });

  it("caches leaderboard pages separately by period", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await getLeaderboard("daily", 10, 0);
    await getLeaderboard("daily", 10, 0);
    await getLeaderboard("monthly", 10, 0);

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(queryHasIdentifier(executeMock.mock.calls[0][0], "leaderboard_daily_mv")).toBe(true);
    expect(queryHasIdentifier(executeMock.mock.calls[1][0], "leaderboard_monthly_mv")).toBe(true);
  });

  it("refreshes and invalidates only the requested period", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await getLeaderboard("daily", 10, 0);
    await getLeaderboard("weekly", 10, 0);
    await getLeaderboardWithRefresh("daily", 10, 0);

    expect(executeMock).toHaveBeenCalledTimes(4);
    expect(queryHasIdentifier(executeMock.mock.calls[2][0], "leaderboard_daily_mv")).toBe(true);
    expect(queryHasIdentifier(executeMock.mock.calls[3][0], "leaderboard_daily_mv")).toBe(true);
  });

  it("uses the period view for a user lookup", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await getUserLeaderboardEntry("GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO", "monthly");

    expect(queryHasIdentifier(executeMock.mock.calls[0][0], "leaderboard_monthly_mv")).toBe(true);
  });
});
