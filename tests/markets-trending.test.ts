import request from "supertest";
import { createApp } from "../src/index";
import * as trendingService from "../src/services/trendingService";

jest.mock("../src/services/trendingService");

const mockedService = jest.mocked(trendingService);

const mockTrendingMarkets = [
  {
    id: "market-1",
    question: "Will ETH hit 5k?",
    status: "active",
    resolution_time: new Date("2026-08-01T00:00:00.000Z"),
    winning_outcome: null,
    metadata: {},
    total_predictions: 120,
    total_volume: 5000,
  },
  {
    id: "market-2",
    question: "Will BTC ETF be approved?",
    status: "active",
    resolution_time: new Date("2026-09-01T00:00:00.000Z"),
    winning_outcome: null,
    metadata: { source: "news" },
    total_predictions: 85,
    total_volume: 3200,
  },
];

describe("GET /api/markets/trending", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns trending markets with correct shape", async () => {
    mockedService.getTrending.mockResolvedValue(mockTrendingMarkets as any);

    const res = await request(createApp()).get("/api/markets/trending");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe("market-1");
    expect(res.body.meta).toEqual({
      limit: 20,
      offset: 0,
      count: 2,
    });
  });

  it("returns empty array when no markets exist", async () => {
    mockedService.getTrending.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/markets/trending");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.count).toBe(0);
  });

  it("respects limit query parameter", async () => {
    mockedService.getTrending.mockResolvedValue([mockTrendingMarkets[0]] as any);

    const res = await request(createApp()).get("/api/markets/trending?limit=5");

    expect(res.status).toBe(200);
    expect(mockedService.getTrending).toHaveBeenCalledWith(5, 0);
    expect(res.body.meta.limit).toBe(5);
  });

  it("respects offset query parameter", async () => {
    mockedService.getTrending.mockResolvedValue([mockTrendingMarkets[1]] as any);

    const res = await request(createApp()).get("/api/markets/trending?offset=10");

    expect(res.status).toBe(200);
    expect(mockedService.getTrending).toHaveBeenCalledWith(20, 10);
    expect(res.body.meta.offset).toBe(10);
  });

  it("rejects limit greater than 100", async () => {
    const res = await request(createApp()).get("/api/markets/trending?limit=101");

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects negative offset", async () => {
    const res = await request(createApp()).get("/api/markets/trending?offset=-1");

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 500 on database error", async () => {
    mockedService.getTrending.mockRejectedValue(new Error("DB connection failed"));

    const res = await request(createApp()).get("/api/markets/trending");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  // ── ETag / conditional GET ─────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    mockedService.getTrending.mockResolvedValue(mockTrendingMarkets as any);

    const res = await request(createApp()).get("/api/markets/trending");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    mockedService.getTrending.mockResolvedValue(mockTrendingMarkets as any);

    const first = await request(createApp()).get("/api/markets/trending");
    const etag = first.headers["etag"] as string;

    const second = await request(createApp())
      .get("/api/markets/trending")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    mockedService.getTrending.mockResolvedValue(mockTrendingMarkets as any);

    const res = await request(createApp())
      .get("/api/markets/trending")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});
