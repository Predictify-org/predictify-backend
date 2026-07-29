process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "portfolio-test-secret-at-least-32-bytes";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

jest.mock("ioredis", () => jest.fn().mockImplementation(() => ({ on: jest.fn(), ping: jest.fn() })));
jest.mock("bullmq", () => ({ Queue: jest.fn().mockImplementation(() => ({ on: jest.fn(), add: jest.fn(), close: jest.fn() })) }));

import request from "supertest";
import { createApp } from "../src/index";
import { getUserPortfolio } from "../src/services/userPortfolioService";

jest.mock("../src/services/userPortfolioService", () => ({
  getUserPortfolio: jest.fn(),
}));

const mockGetUserPortfolio = getUserPortfolio as jest.MockedFunction<typeof getUserPortfolio>;
const ADDRESS = `G${"A".repeat(55)}`;

describe("GET /api/users/:addr/portfolio", () => {
  beforeEach(() => {
    mockGetUserPortfolio.mockReset();
  });

  it("returns an aggregated portfolio", async () => {
    mockGetUserPortfolio.mockResolvedValue({
      address: ADDRESS,
      totals: {
        marketCount: 1,
        predictionCount: 2,
        totalStaked: "125",
        claimableAmount: "50",
        won: 1,
        lost: 0,
        pending: 0,
        confirmed: 1,
        claimed: 0,
      },
      markets: [{
        marketId: "market-1",
        question: "Will this pass?",
        status: "resolved",
        resolutionTime: "2026-07-01T00:00:00.000Z",
        outcome: "yes",
        predictionCount: 2,
        totalStaked: "125",
        claimableAmount: "50",
        latestPredictionAt: "2026-06-29T00:00:00.000Z",
      }],
      cachedAt: "2026-06-29T00:00:01.000Z",
    });

    const res = await request(createApp()).get(`/api/users/${ADDRESS}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual(expect.objectContaining({ totalStaked: "125", claimableAmount: "50" }));
    expect(mockGetUserPortfolio).toHaveBeenCalledWith(ADDRESS);
  });

  it("rejects invalid addresses", async () => {
    const res = await request(createApp()).get("/api/users/not-a-wallet/portfolio");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "invalid_address" } });
    expect(mockGetUserPortfolio).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown users", async () => {
    mockGetUserPortfolio.mockResolvedValue(null);

    const res = await request(createApp()).get(`/api/users/${ADDRESS}/portfolio`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
  });
});
