/**
 * tests/recommendations.test.ts
 *
 * Focused tests for the GET /api/recommendations endpoint.
 * Verifies the pagination envelope shape: { items, next_cursor, total? }
 */

import express from "express";
import request from "supertest";
import { recommendationsRouter } from "../src/routes/markets/recommendations";
import { errorHandler } from "../src/middleware/errorHandler";
import { register } from "../src/metrics/registry";

// Mock requireAuth to pass through with a test user (async to match real signature)
jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).user = { id: "test-user-id", stellarAddress: "GTEST" };
    (req as any).id = "test-req-id";
    next();
  },
}));

// Mock the marketService
jest.mock("../src/services/marketService", () => ({
  getRecommendedMarkets: jest.fn(),
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../src/middleware/etag", () => ({
  conditionalGet: jest.fn(() => false),
}));

import { getRecommendedMarkets } from "../src/services/marketService";
import { conditionalGet } from "../src/middleware/etag";

const mockGetRecommendedMarkets = getRecommendedMarkets as jest.MockedFunction<
  typeof getRecommendedMarkets
>;

const mockConditionalGet = conditionalGet as jest.MockedFunction<typeof conditionalGet>;

const mockMarket = (overrides = {}) => ({
  id: "market-1",
  question: "Will the price of XLM exceed $1 by end of 2026?",
  status: "active",
  resolutionTime: new Date("2026-12-31T23:59:59Z").toISOString(),
  createdAt: new Date("2026-07-28T12:00:00Z"),
  ...overrides,
});

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/recommendations", recommendationsRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/recommendations", () => {
  it("returns items and next_cursor envelope on success", async () => {
    const mockPage = {
      data: [mockMarket()],
      nextCursor: null,
    };

    mockGetRecommendedMarkets.mockResolvedValueOnce(mockPage);

    const res = await request(app).get("/api/recommendations");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("next_cursor");
    expect(res.body).not.toHaveProperty("data");
    expect(res.body).not.toHaveProperty("nextCursor");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("market-1");
    expect(res.body.next_cursor).toBeNull();
  });

  it("returns next_cursor when there are more results", async () => {
    const mockPage = {
      data: [mockMarket({ id: "market-2" }), mockMarket({ id: "market-3" })],
      nextCursor: "eyJzb3J0VmFsdWUiOiIyMDI2LTA3LTI4VDEyOjAwOjAwLjAwMFoiLCJpZCI6Im1hcmtldC0zIn0=",
    };

    mockGetRecommendedMarkets.mockResolvedValueOnce(mockPage);

    const res = await request(app)
      .get("/api/recommendations")
      .query({ limit: "2" });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.next_cursor).toBeDefined();
    expect(typeof res.body.next_cursor).toBe("string");
  });

  it("includes total when the page provides it", async () => {
    const mockPage = {
      data: [mockMarket()],
      nextCursor: null,
      total: 1,
    };

    mockGetRecommendedMarkets.mockResolvedValueOnce(mockPage);

    const res = await request(app).get("/api/recommendations");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("omits total when the page does not provide it", async () => {
    const mockPage = {
      data: [mockMarket()],
      nextCursor: null,
    };

    mockGetRecommendedMarkets.mockResolvedValueOnce(mockPage);

    const res = await request(app).get("/api/recommendations");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("total");
  });

  it("passes limit and cursor query parameters to the service", async () => {
    mockGetRecommendedMarkets.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    await request(app)
      .get("/api/recommendations")
      .query({ limit: "10", cursor: "test-cursor-value" });

    expect(mockGetRecommendedMarkets).toHaveBeenCalledWith(
      "test-user-id",
      { limit: 10, cursor: "test-cursor-value" },
    );
  });

  it("rejects invalid limit parameter", async () => {
    const res = await request(app)
      .get("/api/recommendations")
      .query({ limit: "0" });

    expect(res.status).toBe(400);
  });

  it("rejects limit exceeding 100", async () => {
    const res = await request(app)
      .get("/api/recommendations")
      .query({ limit: "101" });

    expect(res.status).toBe(400);
  });

  it("rejects cursor that is too long", async () => {
    const res = await request(app)
      .get("/api/recommendations")
      .query({ cursor: "x".repeat(513) });

    expect(res.status).toBe(400);
  });

  it("should support conditional GET via ETag", async () => {
    // When conditionalGet returns true, it handles the response (sends 304).
    // The route short-circuits and returns early.
    mockConditionalGet.mockImplementationOnce((_page: unknown, _req: unknown, res: express.Response) => {
      res.status(304).end();
      return true;
    });

    const res = await request(app).get("/api/recommendations");

    expect(res.status).toBe(304);
  });

  it("handles service errors gracefully", async () => {
    mockGetRecommendedMarkets.mockRejectedValueOnce(new Error("Service failure"));

    const res = await request(app).get("/api/recommendations");

    expect(res.status).toBe(500);
  });

  it("handles empty results", async () => {
    mockGetRecommendedMarkets.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    const res = await request(app).get("/api/recommendations");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });
});
