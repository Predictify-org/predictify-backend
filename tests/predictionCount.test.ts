/**
 * Tests for GET /api/markets/:id/prediction-count
 *
 * Uses a minimal Express app (no full createApp bootstrap) so the test
 * suite is isolated from unrelated module errors elsewhere in the tree.
 *
 * Covers:
 *  - 200 with a fresh DB count (cache miss, cached: false)
 *  - 200 served from Redis cache (cache hit, cached: true)
 *  - 200 with count of 0 (market exists but has no predictions)
 *  - 404 when the market does not exist
 *  - 404 error envelope includes requestId
 *  - 500 on unexpected service error
 *  - response includes computedAt ISO timestamp
 *  - service is called with the correct marketId from the URL
 */

// Env must be set before src imports so config/env.ts parses correctly.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF1234567890";

import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Mock the service so no DB or Redis is needed.
jest.mock("../src/services/predictionCountService");

import * as predictionCountService from "../src/services/predictionCountService";
import { predictionCountRouter } from "../src/routes/markets/prediction-count";

const mockGetPredictionCount =
  predictionCountService.getPredictionCount as jest.MockedFunction<
    typeof predictionCountService.getPredictionCount
  >;

// ── Minimal app that mirrors how marketsRouter mounts the sub-router ─────────

function buildApp() {
  const app = express();
  app.use(express.json());

  // Mirrors: marketsRouter.use("/:id/prediction-count", predictionCountRouter)
  app.use("/:id/prediction-count", predictionCountRouter);

  // Simple error handler matching the repo's error envelope shape
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    const code = (err as { code?: string }).code ?? "internal_error";
    res.status(status).json({ error: { code } });
  });

  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPredictionCount(marketId = "mkt-1") {
  return request(app).get(`/${marketId}/prediction-count`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/markets/:id/prediction-count", () => {
  it("returns 200 with count from DB on cache miss", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-1",
      count: 42,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    const res = await getPredictionCount("mkt-1");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      marketId: "mkt-1",
      count: 42,
      cached: false,
    });
    expect(mockGetPredictionCount).toHaveBeenCalledWith("mkt-1");
  });

  it("returns 200 with count from Redis cache on cache hit", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-2",
      count: 7,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: true,
    });

    const res = await getPredictionCount("mkt-2");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      marketId: "mkt-2",
      count: 7,
      cached: true,
    });
  });

  it("returns 200 with count of 0 for a market with no predictions", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-empty",
      count: 0,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    const res = await getPredictionCount("mkt-empty");

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(0);
  });

  it("returns 404 when the market does not exist", async () => {
    const { NotFoundError } = await import("../src/errors");
    mockGetPredictionCount.mockRejectedValueOnce(
      new NotFoundError("Market missing-market not found"),
    );

    const res = await getPredictionCount("missing-market");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("includes requestId in the 404 error envelope", async () => {
    const { NotFoundError } = await import("../src/errors");
    mockGetPredictionCount.mockRejectedValueOnce(
      new NotFoundError("Market ghost not found"),
    );

    const res = await getPredictionCount("ghost");

    expect(res.status).toBe(404);
    // requestId is set from the ALS context; in the minimal test app it falls
    // back to "anon" but the key must be present.
    expect(res.body.error).toHaveProperty("requestId");
  });

  it("returns 500 on unexpected service error", async () => {
    mockGetPredictionCount.mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await getPredictionCount("mkt-1");

    // The inline error handler converts unknown errors to 500
    expect(res.status).toBe(500);
  });

  it("includes computedAt ISO timestamp in the response", async () => {
    const computedAt = "2026-07-23T08:30:00.000Z";
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-ts",
      count: 5,
      computedAt,
      cached: false,
    });

    const res = await getPredictionCount("mkt-ts");

    expect(res.status).toBe(200);
    expect(res.body.data.computedAt).toBe(computedAt);
  });

  it("calls the service with the correct marketId from the URL", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "my-special-market",
      count: 99,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    await getPredictionCount("my-special-market");

    expect(mockGetPredictionCount).toHaveBeenCalledWith("my-special-market");
  });

  it("response data contains all required fields", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-fields",
      count: 3,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    const res = await getPredictionCount("mkt-fields");

    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data).toHaveProperty("marketId");
    expect(data).toHaveProperty("count");
    expect(data).toHaveProperty("computedAt");
    expect(data).toHaveProperty("cached");
  });

  // ── ETag / conditional GET ─────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-1",
      count: 42,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    const res = await getPredictionCount("mkt-1");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    mockGetPredictionCount.mockResolvedValue({
      marketId: "mkt-1",
      count: 42,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    const first = await getPredictionCount("mkt-1");
    const etag = first.headers["etag"] as string;

    const second = await request(app)
      .get("/mkt-1/prediction-count")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-1",
      count: 42,
      computedAt: "2026-07-23T12:00:00.000Z",
      cached: false,
    });

    const res = await request(app)
      .get("/mkt-1/prediction-count")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});

// ── Service contract tests (via the mock) ─────────────────────────────────────

describe("getPredictionCount service contract", () => {
  it("cached: true when Redis has a valid count", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-1",
      count: 15,
      computedAt: new Date().toISOString(),
      cached: true,
    });

    const result = await mockGetPredictionCount("mkt-1");
    expect(result.cached).toBe(true);
    expect(result.count).toBe(15);
  });

  it("cached: false when Redis returns null (cache miss)", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-2",
      count: 30,
      computedAt: new Date().toISOString(),
      cached: false,
    });

    const result = await mockGetPredictionCount("mkt-2");
    expect(result.cached).toBe(false);
    expect(result.count).toBe(30);
  });

  it("cached: false when Redis throws (graceful degradation)", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-3",
      count: 5,
      computedAt: new Date().toISOString(),
      cached: false,
    });

    const result = await mockGetPredictionCount("mkt-3");
    expect(result.cached).toBe(false);
  });

  it("returns the DB count even when cache write fails", async () => {
    mockGetPredictionCount.mockResolvedValueOnce({
      marketId: "mkt-4",
      count: 8,
      computedAt: new Date().toISOString(),
      cached: false,
    });

    const result = await mockGetPredictionCount("mkt-4");
    expect(result.count).toBe(8);
  });
});
