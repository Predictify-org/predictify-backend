process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars!";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000000";

jest.mock("../src/services/leaderboardService");

import request from "supertest";
import express from "express";
import { leaderboardRouter } from "../src/routes/leaderboard";
import * as leaderboardService from "../src/services/leaderboardService";

const mockGetLeaderboard = leaderboardService.getLeaderboard as jest.MockedFunction<
  typeof leaderboardService.getLeaderboard
>;

describe("GET /api/leaderboard timeout handling", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/leaderboard", leaderboardRouter);
  });

  it(
    "responds 504 with a standardized error envelope when the service call hangs past the deadline",
    async () => {
      mockGetLeaderboard.mockImplementationOnce(() => new Promise(() => {}));

      const res = await request(app).get("/api/leaderboard");

      expect(res.status).toBe(504);
      expect(res.body).toEqual({
        error: {
          code: "gateway_timeout",
          message: "Leaderboard request timed out",
          requestId: expect.any(String),
        },
      });
    },
    8000,
  );

  it(
    "does not throw or double-respond when the hung call resolves after the timeout has already fired",
    async () => {
      let resolveLate: (value: leaderboardService.LeaderboardEntry[]) => void = () => {};
      mockGetLeaderboard.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLate = resolve;
          }),
      );

      const res = await request(app).get("/api/leaderboard");
      expect(res.status).toBe(504);

      resolveLate([]);
      await new Promise((r) => setTimeout(r, 50));
    },
    8000,
  );

  it("responds normally within the deadline when the service resolves quickly", async () => {
    mockGetLeaderboard.mockResolvedValueOnce([]);

    const res = await request(app).get("/api/leaderboard");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
