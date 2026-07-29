import request from "supertest";
import { createApp } from "../src/index";
import * as marketService from "../src/services/marketService";

jest.mock("../src/services/marketService", () => ({
  ...jest.requireActual("../src/services/marketService"),
  listUpcomingMarkets: jest.fn(),
}));

const mockListUpcoming = marketService.listUpcomingMarkets as jest.Mock;

describe("GET /api/markets/upcoming", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns the list of upcoming markets", async () => {
    mockListUpcoming.mockResolvedValue([
      {
        id: "mkt-2",
        question: "Will the next block confirm in time?",
        status: "upcoming",
        resolutionTime: "2026-08-01T00:00:00.000Z",
      },
    ]);

    const res = await request(createApp()).get("/api/markets/upcoming");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("upcoming");
    expect(mockListUpcoming).toHaveBeenCalledWith({ limit: 50 });
  });

  it("passes through a valid limit", async () => {
    mockListUpcoming.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/markets/upcoming?limit=5");

    expect(res.status).toBe(200);
    expect(mockListUpcoming).toHaveBeenCalledWith({ limit: 5 });
  });

  it("rejects an invalid limit with 400", async () => {
    const res = await request(createApp()).get("/api/markets/upcoming?limit=1000");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(mockListUpcoming).not.toHaveBeenCalled();
  });

  // ── ETag / conditional GET ─────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    mockListUpcoming.mockResolvedValue([
      {
        id: "mkt-1",
        question: "Will it ship?",
        status: "upcoming",
        resolutionTime: "2026-08-01T00:00:00.000Z",
      },
    ]);

    const res = await request(createApp()).get("/api/markets/upcoming");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    mockListUpcoming.mockResolvedValue([
      {
        id: "mkt-1",
        question: "Will it ship?",
        status: "upcoming",
        resolutionTime: "2026-08-01T00:00:00.000Z",
      },
    ]);

    const first = await request(createApp()).get("/api/markets/upcoming");
    const etag = first.headers["etag"] as string;

    const second = await request(createApp())
      .get("/api/markets/upcoming")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    mockListUpcoming.mockResolvedValue([
      {
        id: "mkt-1",
        question: "Will it ship?",
        status: "upcoming",
        resolutionTime: "2026-08-01T00:00:00.000Z",
      },
    ]);

    const res = await request(createApp())
      .get("/api/markets/upcoming")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});
