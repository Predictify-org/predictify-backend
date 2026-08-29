/**
 * Tests for GET /api/markets/:id/watchers, POST /api/markets/:id/watchers, and DELETE /api/markets/:id/watchers
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";

import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const authMock = {
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
    }
    (req as any).user = { id: "user-123", stellarAddress: "GABC123" };
    next();
  },
};
jest.mock("../src/middleware/auth", () => authMock);
jest.mock("../src/middleware/requireAuth", () => authMock);
jest.mock("../src/services/marketWatcherService");



import * as marketWatcherService from "../src/services/marketWatcherService";
import { watchersRouter } from "../src/routes/markets/watchers";
import { NotFoundError } from "../src/errors";

const mockListMarketWatchers = marketWatcherService.listMarketWatchers as jest.MockedFunction<
  typeof marketWatcherService.listMarketWatchers
>;
const mockAddMarketWatcher = marketWatcherService.addMarketWatcher as jest.MockedFunction<
  typeof marketWatcherService.addMarketWatcher
>;
const mockRemoveMarketWatcher = marketWatcherService.removeMarketWatcher as jest.MockedFunction<
  typeof marketWatcherService.removeMarketWatcher
>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/:id/watchers", watchersRouter);

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

describe("GET /api/markets/:id/watchers", () => {
  it("returns 200 with list of watchers and pagination info", async () => {
    mockListMarketWatchers.mockResolvedValueOnce({
      data: [
        {
          id: "w-1",
          marketId: "mkt-1",
          userId: "u-1",
          stellarAddress: "GABC123",
          createdAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      nextCursor: "cursor-token-123",
      total: 1,
    });

    const res = await request(app).get("/mkt-1/watchers?limit=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: "w-1",
          marketId: "mkt-1",
          userId: "u-1",
          stellarAddress: "GABC123",
          createdAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      nextCursor: "cursor-token-123",
      total: 1,
    });
    expect(mockListMarketWatchers).toHaveBeenCalledWith("mkt-1", { limit: 10 });
  });

  it("returns 200 with empty list when market has no watchers", async () => {
    mockListMarketWatchers.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
      total: 0,
    });

    const res = await request(app).get("/mkt-empty/watchers");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.total).toBe(0);
  });

  it("returns 404 when market does not exist", async () => {
    mockListMarketWatchers.mockRejectedValueOnce(new NotFoundError("Market missing-mkt not found"));

    const res = await request(app).get("/missing-mkt/watchers");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 validation error when query limit is negative or too large", async () => {
    const res = await request(app).get("/mkt-1/watchers?limit=500");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  // ── ETag / conditional GET ─────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    mockListMarketWatchers.mockResolvedValueOnce({
      data: [{ id: "w-1", marketId: "mkt-1", userId: "u-1", stellarAddress: "GABC123", createdAt: "2026-07-25T10:00:00.000Z" }],
      nextCursor: null,
      total: 1,
    });

    const res = await request(app).get("/mkt-1/watchers");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    mockListMarketWatchers.mockResolvedValue({
      data: [{ id: "w-1", marketId: "mkt-1", userId: "u-1", stellarAddress: "GABC123", createdAt: "2026-07-25T10:00:00.000Z" }],
      nextCursor: null,
      total: 1,
    });

    const first = await request(app).get("/mkt-1/watchers");
    const etag = first.headers["etag"] as string;

    const second = await request(app)
      .get("/mkt-1/watchers")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    mockListMarketWatchers.mockResolvedValueOnce({
      data: [{ id: "w-1", marketId: "mkt-1", userId: "u-1", stellarAddress: "GABC123", createdAt: "2026-07-25T10:00:00.000Z" }],
      nextCursor: null,
      total: 1,
    });

    const res = await request(app)
      .get("/mkt-1/watchers")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});

describe("POST /api/markets/:id/watchers", () => {
  it("returns 201 when adding authenticated user to watchers", async () => {
    mockAddMarketWatcher.mockResolvedValueOnce({
      id: "w-2",
      marketId: "mkt-1",
      userId: "user-123",
      stellarAddress: "GABC123",
      createdAt: "2026-07-26T12:00:00.000Z",
    });

    const res = await request(app)
      .post("/mkt-1/watchers")
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty("id", "w-2");
    expect(mockAddMarketWatcher).toHaveBeenCalledWith("mkt-1", "user-123");
  });

  it("returns 401 when authorization header is missing", async () => {
    const res = await request(app).post("/mkt-1/watchers");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 404 when target market does not exist", async () => {
    mockAddMarketWatcher.mockRejectedValueOnce(new NotFoundError("Market ghost not found"));

    const res = await request(app)
      .post("/ghost/watchers")
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("DELETE /api/markets/:id/watchers", () => {
  it("returns 200 when removing watcher", async () => {
    mockRemoveMarketWatcher.mockResolvedValueOnce(true);

    const res = await request(app)
      .delete("/mkt-1/watchers")
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("unsubscribed");
    expect(mockRemoveMarketWatcher).toHaveBeenCalledWith("mkt-1", "user-123");
  });

  it("returns 401 when authorization header is missing", async () => {
    const res = await request(app).delete("/mkt-1/watchers");

    expect(res.status).toBe(401);
  });
});
