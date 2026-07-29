import request from "supertest";
import express from "express";
import { createPerUserRateLimiter } from "../src/middleware/rateLimit";

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

function makeApp(limit = 2) {
  const app = express();
  app.use(express.json());

  // Mock auth middleware populating req.user
  app.use((req, _res, next) => {
    const userId = req.headers["x-test-user"];
    if (typeof userId === "string") {
      (req as unknown as { user?: { id: string } }).user = { id: userId };
    }
    next();
  });

  // Predictions router rate limiter middleware
  app.use(
    "/api/predictions",
    createPerUserRateLimiter({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) => {
        const userId = (req as unknown as { user?: { id: string } }).user?.id;
        if (typeof userId === "string" && userId.trim().length > 0) {
          return `predictions:${userId}`;
        }
        return `predictions:unknown`;
      },
    }),
  );

  app.get("/api/predictions", (_req, res) => {
    res.json({ data: [], nextCursor: null });
  });

  return app;
}

describe("GET /api/predictions — per-user rate limiting (#401, #484)", () => {
  it("enforces rate limit independently per authenticated user", async () => {
    const app = makeApp(2);

    expect((await request(app).get("/api/predictions").set("x-test-user", "user-1")).status).toBe(200);
    expect((await request(app).get("/api/predictions").set("x-test-user", "user-1")).status).toBe(200);
    expect((await request(app).get("/api/predictions").set("x-test-user", "user-1")).status).toBe(429);

    // Second user is not blocked (independent bucket)
    const user2Res = await request(app).get("/api/predictions").set("x-test-user", "user-2");
    expect(user2Res.status).toBe(200);
  });

  it("returns standard 429 error envelope with Retry-After header", async () => {
    const app = makeApp(1);

    await request(app).get("/api/predictions").set("x-test-user", "user-1");
    const blockedRes = await request(app).get("/api/predictions").set("x-test-user", "user-1");

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.error).toBeDefined();
    expect(blockedRes.body.error.code).toBe("rate_limit_exceeded");
    expect(blockedRes.body.error.message).toBe("Too many requests");

    const retryAfterHeader = blockedRes.headers["retry-after"];
    expect(retryAfterHeader).toBeDefined();
    expect(Number(retryAfterHeader)).toBeGreaterThanOrEqual(1);

    expect(blockedRes.body.error.retryAfter).toBe(Number(retryAfterHeader));
    expect(typeof blockedRes.body.error.resetAt).toBe("string");
  });
});
