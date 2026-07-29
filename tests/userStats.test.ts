process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "stats-test-secret-at-least-32-bytes";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

jest.mock("ioredis", () => jest.fn().mockImplementation(() => ({ on: jest.fn(), ping: jest.fn() })));
jest.mock("bullmq", () => ({ Queue: jest.fn().mockImplementation(() => ({ on: jest.fn(), add: jest.fn(), close: jest.fn() })) }));

import request from "supertest";
import { createApp } from "../src/index";
import { getUserStats } from "../src/services/userStatsService";

jest.mock("../src/services/userStatsService", () => ({
  getUserStats: jest.fn(),
}));

const mockGetUserStats = getUserStats as jest.MockedFunction<typeof getUserStats>;
const ADDRESS = `G${"A".repeat(55)}`;

describe("GET /api/users/:addr/stats", () => {
  beforeEach(() => {
    mockGetUserStats.mockReset();
  });

  it("returns per-user aggregated stats", async () => {
    mockGetUserStats.mockResolvedValue({
      address: ADDRESS,
      totalPredictions: 42,
      totalStaked: "15000",
      marketsParticipated: 8,
      byStatus: { won: 12, lost: 5, pending: 20, confirmed: 3, claimed: 2 },
      totalClaimed: "5000",
      winRate: 0.71,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    const res = await request(createApp()).get(`/api/users/${ADDRESS}/stats`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        address: ADDRESS,
        totalPredictions: 42,
        totalStaked: "15000",
        marketsParticipated: 8,
        winRate: 0.71,
      }),
    );
    expect(res.body.data.byStatus).toEqual({ won: 12, lost: 5, pending: 20, confirmed: 3, claimed: 2 });
    expect(mockGetUserStats).toHaveBeenCalledWith(ADDRESS);
  });

  it("rejects invalid addresses", async () => {
    const res = await request(createApp()).get("/api/users/not-a-wallet/stats");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "invalid_address" } });
    expect(mockGetUserStats).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown users", async () => {
    mockGetUserStats.mockResolvedValue(null);

    const res = await request(createApp()).get(`/api/users/${ADDRESS}/stats`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
  });
});
