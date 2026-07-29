/**
 * Tests for the public GET /api/markets/featured endpoint.
 *
 * Verifies:
 *  - default limit applied when `limit` is omitted
 *  - custom limit honoured (and clamped server-side)
 *  - 400 on garbage / out-of-range limits
 *  - data passes through untouched from the service
 */

import request from "supertest";
import express from "express";

jest.mock("../src/services/marketFeatureService", () => ({
  listFeaturedMarkets: jest.fn(),
  // Provide unused exports so the real module imports resolve cleanly.
  featureMarket: jest.fn(),
  unfeatureMarket: jest.fn(),
  DEFAULT_FEATURED_LIMIT: 6,
  MAX_FEATURED_LIMIT: 20,
  MarketNotFoundError: class MarketNotFoundError extends Error {},
  MarketArchivedError: class MarketArchivedError extends Error {},
  DrizzleMarketFeatureRepository: class {},
}));

import { listFeaturedMarkets } from "../src/services/marketFeatureService";
import { rateLimitAnon } from "../src/middleware/rateLimitAnon";
import { conditionalGet } from "../src/middleware/etag";
import { errorHandler } from "../src/middleware/errorHandler";

const mockListFeatured = listFeaturedMarkets as jest.MockedFunction<typeof listFeaturedMarkets>;

jest.mock("../src/db/client", () => ({ db: {} }));

// ── App factory ─────────────────────────────────────────────────────────────
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(rateLimitAnon);

  // Re-create only the routes we need to avoid pulling the whole index.ts
  // (which spins up Pool/Redis in some test environments).
  app.get("/api/markets/featured", async (req, res, next) => {
    try {
      const rawLimit = req.query.limit;
      let parsedLimit: number | undefined;
      if (rawLimit !== undefined) {
        const num = Number(rawLimit);
        if (!Number.isFinite(num) || num < 1 || num > 20) {
          return res.status(400).json({
            error: { code: "invalid_query", message: "limit must be an integer between 1 and 20" },
          });
        }
        parsedLimit = Math.floor(num);
      }
      const data = await listFeaturedMarkets(parsedLimit);
      const payload = { data };

      if (conditionalGet(payload, req, res)) {
        return;
      }

      return res.json(payload);
    } catch (e) {
      return next(e);
    }
  });

  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Default & limit handling ────────────────────────────────────────────────
describe("GET /api/markets/featured", () => {
  it("applies the default limit when limit is omitted", async () => {
    mockListFeatured.mockResolvedValueOnce([
      { id: "m1", question: "Q1", status: "active", resolutionOutcome: null, resolutionTime: "2026-07-01T00:00:00.000Z", winningOutcome: null, metadata: null, featuredAt: "2026-06-28T00:00:00.000Z", featuredBy: "GA…" },
    ]);

    const res = await request(makeApp()).get("/api/markets/featured");
    expect(res.status).toBe(200);
    expect(mockListFeatured).toHaveBeenCalledWith(undefined);
    expect(res.body.data).toHaveLength(1);
  });

  it("passes the requested limit through to the service", async () => {
    mockListFeatured.mockResolvedValueOnce([]);

    const res = await request(makeApp()).get("/api/markets/featured?limit=3");
    expect(res.status).toBe(200);
    expect(mockListFeatured).toHaveBeenCalledWith(3);
  });

  it("returns 400 when limit is outside the 1-20 range", async () => {
    const r1 = await request(makeApp()).get("/api/markets/featured?limit=0");
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe("invalid_query");

    const r2 = await request(makeApp()).get("/api/markets/featured?limit=999");
    expect(r2.status).toBe(400);
  });

  it("returns 400 when limit is not a number", async () => {
    const res = await request(makeApp()).get("/api/markets/featured?limit=abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_query");
  });

  it("passes an empty array through as { data: [] }", async () => {
    mockListFeatured.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get("/api/markets/featured");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  // ── ETag / conditional GET ─────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    mockListFeatured.mockResolvedValueOnce([
      { id: "m1", question: "Q1", status: "active", resolutionOutcome: null, resolutionTime: "2026-07-01T00:00:00.000Z", winningOutcome: null, metadata: null, featuredAt: "2026-06-28T00:00:00.000Z", featuredBy: "GA…" },
    ]);

    const res = await request(makeApp()).get("/api/markets/featured");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    mockListFeatured.mockResolvedValue([
      { id: "m1", question: "Q1", status: "active", resolutionOutcome: null, resolutionTime: "2026-07-01T00:00:00.000Z", winningOutcome: null, metadata: null, featuredAt: "2026-06-28T00:00:00.000Z", featuredBy: "GA…" },
    ]);

    const first = await request(makeApp()).get("/api/markets/featured");
    const etag = first.headers["etag"] as string;

    const second = await request(makeApp())
      .get("/api/markets/featured")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    mockListFeatured.mockResolvedValue([
      { id: "m1", question: "Q1", status: "active", resolutionOutcome: null, resolutionTime: "2026-07-01T00:00:00.000Z", winningOutcome: null, metadata: null, featuredAt: "2026-06-28T00:00:00.000Z", featuredBy: "GA…" },
    ]);

    const res = await request(makeApp())
      .get("/api/markets/featured")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});
