import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { ZodError } from "zod";
import { leaderboardRouter } from "../src/routes/leaderboard";
import {
  getLeaderboard,
  getLeaderboardWithRefresh,
  getUserLeaderboardEntry,
} from "../src/services/leaderboardService";

jest.mock("../src/services/leaderboardService", () => ({
  leaderboardPeriods: ["daily", "weekly", "monthly"],
  getLeaderboard: jest.fn(),
  getLeaderboardWithRefresh: jest.fn(),
  getUserLeaderboardEntry: jest.fn(),
}));

const mockedGetLeaderboard = getLeaderboard as jest.MockedFunction<typeof getLeaderboard>;
const mockedGetLeaderboardWithRefresh = getLeaderboardWithRefresh as jest.MockedFunction<typeof getLeaderboardWithRefresh>;
const mockedGetUserLeaderboardEntry = getUserLeaderboardEntry as jest.MockedFunction<typeof getUserLeaderboardEntry>;

function createLeaderboardApp() {
  const app = express();
  app.use("/api/leaderboard", leaderboardRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: "invalid_query" } });
      return;
    }
    res.status(500).json({ error: { code: "internal_error" } });
  });
  return app;
}

describe("leaderboardRouter period query", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes the requested period to the service and returns it in meta", async () => {
    mockedGetLeaderboard.mockResolvedValue([]);

    const res = await request(createLeaderboardApp()).get("/api/leaderboard?period=weekly&limit=20&offset=10");

    expect(res.status).toBe(200);
    expect(mockedGetLeaderboard).toHaveBeenCalledWith("weekly", 20, 10);
    expect(res.body.meta).toMatchObject({ period: "weekly", limit: 20, offset: 10, refresh: false });
  });

  it("defaults the period to daily", async () => {
    mockedGetLeaderboard.mockResolvedValue([]);

    const res = await request(createLeaderboardApp()).get("/api/leaderboard");

    expect(res.status).toBe(200);
    expect(mockedGetLeaderboard).toHaveBeenCalledWith("daily", 50, 0);
    expect(res.body.meta.period).toBe("daily");
  });

  it("refreshes only the selected period", async () => {
    mockedGetLeaderboardWithRefresh.mockResolvedValue([]);

    const res = await request(createLeaderboardApp()).get("/api/leaderboard?period=monthly&refresh=true");

    expect(res.status).toBe(200);
    expect(mockedGetLeaderboardWithRefresh).toHaveBeenCalledWith("monthly", 50, 0);
  });

  it("rejects unknown periods", async () => {
    const res = await request(createLeaderboardApp()).get("/api/leaderboard?period=yearly");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "invalid_query" } });
    expect(mockedGetLeaderboard).not.toHaveBeenCalled();
  });

  it("passes period to user leaderboard lookup", async () => {
    mockedGetUserLeaderboardEntry.mockResolvedValue({
      user_id: "user-1",
      stellar_address: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
      total_predictions: 3,
      correct_predictions: 2,
      accuracy_percentage: 66.67,
      rank: 1,
    });

    const res = await request(createLeaderboardApp()).get(
      "/api/leaderboard/user/GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO?period=monthly",
    );

    expect(res.status).toBe(200);
    expect(mockedGetUserLeaderboardEntry).toHaveBeenCalledWith(
      "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
      "monthly",
    );
    expect(res.body.meta.period).toBe("monthly");
  });
});
