/**
 * Route tests for global leaderboard endpoints.
 *
 * Uses a minimal standalone Express app (no createApp) so these tests are
 * fully isolated from unrelated pre-existing TypeScript errors in other
 * source files.
 *
 * GET /api/leaderboard/global
 * GET /api/leaderboard/global/user/:stellarAddress
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { globalLeaderboardRouter } from "../src/routes/leaderboard/global";
import * as globalLeaderboardService from "../src/services/globalLeaderboardService";

jest.mock("../src/services/globalLeaderboardService");
jest.mock("../src/middleware/rateLimitAnon", () => ({
  rateLimitAnon: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Test app ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  // Attach a minimal errorHandler so 500s are returned as JSON
  app.use("/api/leaderboard/global", globalLeaderboardRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: { code: err.code ?? "internal_error" } });
  });
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockGetGlobalLeaderboard =
  globalLeaderboardService.getGlobalLeaderboard as jest.MockedFunction<
    typeof globalLeaderboardService.getGlobalLeaderboard
  >;
const mockGetGlobalLeaderboardWithRefresh =
  globalLeaderboardService.getGlobalLeaderboardWithRefresh as jest.MockedFunction<
    typeof globalLeaderboardService.getGlobalLeaderboardWithRefresh
  >;
const mockGetGlobalLeaderboardEntry =
  globalLeaderboardService.getGlobalLeaderboardEntry as jest.MockedFunction<
    typeof globalLeaderboardService.getGlobalLeaderboardEntry
  >;

const sampleEntry: globalLeaderboardService.GlobalLeaderboardEntry = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  stellar_address: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
  total_predictions: 120,
  correct_predictions: 96,
  accuracy_percentage: 80.0,
  total_markets: 8,
  rank: 1,
};

const sampleEntry2: globalLeaderboardService.GlobalLeaderboardEntry = {
  user_id: "660e8400-e29b-41d4-a716-446655440001",
  stellar_address: "GBTCHKHMWCS5TOX2LAD4DAEKTC3UFSFXQ2MRLED5EYOA34RH4ZX72JK",
  total_predictions: 60,
  correct_predictions: 42,
  accuracy_percentage: 70.0,
  total_markets: 3,
  rank: 2,
};

let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  jest.clearAllMocks();
  app = buildApp();
});

// ── GET /api/leaderboard/global ───────────────────────────────────────────────

describe("GET /api/leaderboard/global", () => {
  it("returns 200 with paginated entries and default meta", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app).get("/api/leaderboard/global");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([sampleEntry]);
    expect(res.body.meta).toMatchObject({ limit: 50, offset: 0, count: 1, refresh: false });
    expect(mockGetGlobalLeaderboard).toHaveBeenCalledWith(50, 0);
  });

  it("returns multiple entries", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry, sampleEntry2]);

    const res = await request(app).get("/api/leaderboard/global");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.count).toBe(2);
  });

  it("respects custom limit and offset", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: 10, offset: 20 });

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ limit: 10, offset: 20 });
    expect(mockGetGlobalLeaderboard).toHaveBeenCalledWith(10, 20);
  });

  it("coerces string query params to numbers", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: "25", offset: "50" });

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(25);
    expect(res.body.meta.offset).toBe(50);
    expect(mockGetGlobalLeaderboard).toHaveBeenCalledWith(25, 50);
  });

  it("calls the refresh variant when refresh=true", async () => {
    mockGetGlobalLeaderboardWithRefresh.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ refresh: "true" });

    expect(res.status).toBe(200);
    expect(res.body.meta.refresh).toBe(true);
    expect(mockGetGlobalLeaderboardWithRefresh).toHaveBeenCalledWith(50, 0);
    expect(mockGetGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it("calls refresh variant with custom pagination", async () => {
    mockGetGlobalLeaderboardWithRefresh.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ refresh: true, limit: 10, offset: 5 });

    expect(res.status).toBe(200);
    expect(mockGetGlobalLeaderboardWithRefresh).toHaveBeenCalledWith(10, 5);
  });

  it("returns empty array when no entries exist", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([]);

    const res = await request(app).get("/api/leaderboard/global");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.count).toBe(0);
  });

  it("returns 400 when limit exceeds 100", async () => {
    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: 101 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(mockGetGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it("returns 400 when limit is zero", async () => {
    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: 0 });

    expect(res.status).toBe(400);
    expect(mockGetGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it("returns 400 when limit is negative", async () => {
    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: -5 });

    expect(res.status).toBe(400);
    expect(mockGetGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it("returns 400 when offset is negative", async () => {
    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ offset: -1 });

    expect(res.status).toBe(400);
    expect(mockGetGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it("returns 400 when limit is not a number", async () => {
    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("accepts limit=100 (maximum)", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(100);
  });

  it("accepts limit=1 (minimum)", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(1);
  });

  it("returns 500 when the service throws", async () => {
    mockGetGlobalLeaderboard.mockRejectedValueOnce(new Error("DB unavailable"));

    const res = await request(app).get("/api/leaderboard/global");

    expect(res.status).toBe(500);
  });

  it("returns 500 when the refresh service throws", async () => {
    mockGetGlobalLeaderboardWithRefresh.mockRejectedValueOnce(new Error("Refresh failed"));

    const res = await request(app)
      .get("/api/leaderboard/global")
      .query({ refresh: true });

    expect(res.status).toBe(500);
  });

  it("includes all required meta fields", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app).get("/api/leaderboard/global");

    expect(res.body.meta).toHaveProperty("limit");
    expect(res.body.meta).toHaveProperty("offset");
    expect(res.body.meta).toHaveProperty("count");
    expect(res.body.meta).toHaveProperty("refresh");
  });

  it("returns all GlobalLeaderboardEntry fields", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry]);

    const res = await request(app).get("/api/leaderboard/global");
    const entry = res.body.data[0];

    expect(entry).toHaveProperty("user_id");
    expect(entry).toHaveProperty("stellar_address");
    expect(entry).toHaveProperty("total_predictions");
    expect(entry).toHaveProperty("correct_predictions");
    expect(entry).toHaveProperty("accuracy_percentage");
    expect(entry).toHaveProperty("total_markets");
    expect(entry).toHaveProperty("rank");
  });

  it("returns data as array", async () => {
    mockGetGlobalLeaderboard.mockResolvedValueOnce([sampleEntry, sampleEntry2]);

    const res = await request(app).get("/api/leaderboard/global");

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);
  });
});

// ── GET /api/leaderboard/global/user/:stellarAddress ─────────────────────────

describe("GET /api/leaderboard/global/user/:stellarAddress", () => {
  it("returns 200 with the user entry", async () => {
    mockGetGlobalLeaderboardEntry.mockResolvedValueOnce(sampleEntry);

    const res = await request(app).get(
      `/api/leaderboard/global/user/${sampleEntry.stellar_address}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(sampleEntry);
    expect(mockGetGlobalLeaderboardEntry).toHaveBeenCalledWith(
      sampleEntry.stellar_address,
    );
  });

  it("returns 404 when address not on leaderboard", async () => {
    mockGetGlobalLeaderboardEntry.mockResolvedValueOnce(null);

    const res = await request(app).get(
      "/api/leaderboard/global/user/GUNKNOWNADDRESS",
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 500 when service throws", async () => {
    mockGetGlobalLeaderboardEntry.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get(
      `/api/leaderboard/global/user/${sampleEntry.stellar_address}`,
    );

    expect(res.status).toBe(500);
  });

  it("passes the exact stellar address to the service", async () => {
    const addr = "GBTCHKHMWCS5TOX2LAD4DAEKTC3UFSFXQ2MRLED5EYOA34RH4ZX72JK";
    mockGetGlobalLeaderboardEntry.mockResolvedValueOnce({ ...sampleEntry, stellar_address: addr, rank: 2 });

    const res = await request(app).get(`/api/leaderboard/global/user/${addr}`);

    expect(res.status).toBe(200);
    expect(mockGetGlobalLeaderboardEntry).toHaveBeenCalledWith(addr);
  });

  it("returns correct rank and stats", async () => {
    mockGetGlobalLeaderboardEntry.mockResolvedValueOnce(sampleEntry);

    const res = await request(app).get(
      `/api/leaderboard/global/user/${sampleEntry.stellar_address}`,
    );

    expect(res.body.data.rank).toBe(sampleEntry.rank);
    expect(res.body.data.accuracy_percentage).toBe(sampleEntry.accuracy_percentage);
    expect(res.body.data.total_markets).toBe(sampleEntry.total_markets);
  });

  it("returns data as object not array", async () => {
    mockGetGlobalLeaderboardEntry.mockResolvedValueOnce(sampleEntry);

    const res = await request(app).get(
      `/api/leaderboard/global/user/${sampleEntry.stellar_address}`,
    );

    expect(typeof res.body.data).toBe("object");
    expect(Array.isArray(res.body.data)).toBe(false);
  });

  it("includes all required entry fields", async () => {
    mockGetGlobalLeaderboardEntry.mockResolvedValueOnce(sampleEntry);

    const res = await request(app).get(
      `/api/leaderboard/global/user/${sampleEntry.stellar_address}`,
    );
    const entry = res.body.data;

    expect(entry).toHaveProperty("user_id");
    expect(entry).toHaveProperty("stellar_address");
    expect(entry).toHaveProperty("total_predictions");
    expect(entry).toHaveProperty("correct_predictions");
    expect(entry).toHaveProperty("accuracy_percentage");
    expect(entry).toHaveProperty("total_markets");
    expect(entry).toHaveProperty("rank");
  });
});
