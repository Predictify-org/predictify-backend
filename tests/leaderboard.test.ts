process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "leaderboard-test-secret-at-least-32-bytes";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

jest.mock("../src/db/client", () => ({ db: {} }));
jest.mock("../src/services/addressAggregatesService");

import request from "supertest";
import { createApp } from "../src/index";
import * as addressAggregatesService from "../src/services/addressAggregatesService";

const mockGetAddressAggregates = addressAggregatesService.getAddressAggregates as jest.MockedFunction<
  typeof addressAggregatesService.getAddressAggregates
>;
const mockGetAddressAggregatesWithRefresh = addressAggregatesService.getAddressAggregatesWithRefresh as jest.MockedFunction<
  typeof addressAggregatesService.getAddressAggregatesWithRefresh
>;
const mockGetAddressAggregate = addressAggregatesService.getAddressAggregate as jest.MockedFunction<
  typeof addressAggregatesService.getAddressAggregate
>;

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
});

const sampleEntry = {
  user_id: "u1",
  stellar_address: "GAAA",
  total_predictions: 10,
  correct_predictions: 7,
  accuracy_percentage: 70.0,
  rank: 1,
};

describe("GET /api/leaderboard", () => {
  it("returns paginated leaderboard entries", async () => {
    mockGetAddressAggregates.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app).get("/api/leaderboard");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([sampleEntry]);
    expect(res.body.meta).toMatchObject({
      limit: 50,
      offset: 0,
      count: 1,
      refresh: false,
    });
  });

  it("accepts limit and offset query params", async () => {
    mockGetAddressAggregates.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/leaderboard")
      .query({ limit: 10, offset: 20 });

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ limit: 10, offset: 20, refresh: false });
    expect(mockGetAddressAggregates).toHaveBeenCalledWith(10, 20);
  });

  it("rejects limit > 100", async () => {
    const res = await request(app)
      .get("/api/leaderboard")
      .query({ limit: 200 });

    expect(res.status).toBe(400);
  });

  it("uses refresh endpoint when refresh=true", async () => {
    mockGetAddressAggregatesWithRefresh.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app)
      .get("/api/leaderboard")
      .query({ refresh: "true" });

    expect(res.status).toBe(200);
    expect(res.body.meta.refresh).toBe(true);
    expect(mockGetAddressAggregatesWithRefresh).toHaveBeenCalled();
  });
});

describe("GET /api/leaderboard/user/:stellarAddress", () => {
  it("returns a user's leaderboard entry", async () => {
    mockGetAddressAggregate.mockResolvedValueOnce(sampleEntry);

    const res = await request(app).get("/api/leaderboard/user/GAAA");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(sampleEntry);
  });

  it("returns 404 for unknown address", async () => {
    mockGetAddressAggregate.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/leaderboard/user/GZZZ");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});
