import request from "supertest";
import { createApp } from "../src/index";
import * as marketRepo from "../src/repositories/marketRepository";
import { db } from "../src/db/client";

describe("GET /api/markets/search", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 400 when q parameter is missing", async () => {
    const res = await request(createApp()).get("/api/markets/search");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when q parameter is whitespace", async () => {
    const res = await request(createApp()).get("/api/markets/search?q=%20%20");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 200 with FTS search results and correct pagination", async () => {
    jest.spyOn(marketRepo, "searchMarkets").mockResolvedValue({
      data: [{ id: "m-1", question: "Will Bitcoin hit 100k?" }],
      total: 1,
      fallback: false,
    });

    const res = await request(createApp()).get("/api/markets/search?q=Bitcoin&limit=10&page=2");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.page).toBe(2);
    expect(res.body.fallback).toBe(false);
  });

  it("returns 200 indicating fuzzy trigram fallback when FTS has no exact matches", async () => {
    jest.spyOn(marketRepo, "searchMarkets").mockResolvedValue({
      data: [{ id: "m-2", question: "Bitcon price prediction" }],
      total: 1,
      fallback: true,
    });

    const res = await request(createApp()).get("/api/markets/search?q=Bitcon");
    expect(res.status).toBe(200);
    expect(res.body.fallback).toBe(true);
  });

  // ── ETag / conditional GET ──────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    jest.spyOn(marketRepo, "searchMarkets").mockResolvedValue({
      data: [{ id: "m-1", question: "Will Bitcoin hit 100k?" }],
      total: 1,
      fallback: false,
    });

    const res = await request(createApp()).get("/api/markets/search?q=Bitcoin");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    jest.spyOn(marketRepo, "searchMarkets").mockResolvedValue({
      data: [{ id: "m-1", question: "Will Bitcoin hit 100k?" }],
      total: 1,
      fallback: false,
    });

    const first = await request(createApp()).get("/api/markets/search?q=Bitcoin");
    const etag = first.headers["etag"] as string;

    const second = await request(createApp())
      .get("/api/markets/search?q=Bitcoin")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    jest.spyOn(marketRepo, "searchMarkets").mockResolvedValue({
      data: [{ id: "m-1", question: "Will Bitcoin hit 100k?" }],
      total: 1,
      fallback: false,
    });

    const res = await request(createApp())
      .get("/api/markets/search?q=Bitcoin")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});

describe("searchMarkets repository", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns empty data when query is empty", async () => {
    const result = await marketRepo.searchMarkets({ query: "   " });
    expect(result).toEqual({ data: [], total: 0, fallback: false });
  });

  it("returns FTS matches when found", async () => {
    jest.spyOn(db, "execute").mockResolvedValueOnce({
      rows: [{ full_total: 1, rank_score: 0.5, id: "m-1", resolutionTime: new Date("2026-01-01") }],
    } as any);

    const result = await marketRepo.searchMarkets({ query: "BTC" });
    expect(result.fallback).toBe(false);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe("m-1");
  });

  it("falls back to trigram when FTS returns empty rows", async () => {
    jest.spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [] } as any) // FTS
      .mockResolvedValueOnce({ rows: [{ full_total: 1, sim_score: 0.4, id: "m-2", resolutionTime: "2026-01-01" }] } as any); // Trigram

    const result = await marketRepo.searchMarkets({ query: "BTCC" });
    expect(result.fallback).toBe(true);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe("m-2");
  });

  it("handles database errors gracefully and returns empty array", async () => {
    jest.spyOn(db, "execute").mockRejectedValue(new Error("DB offline"));

    const result = await marketRepo.searchMarkets({ query: "BTC" });
    expect(result).toEqual({ data: [], total: 0, fallback: false });
  });
});
