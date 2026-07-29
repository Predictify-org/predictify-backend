/**
 * Rate-limit coverage for /api/users (issue #411 / users-rl-v7).
 *
 * Mirrors the production mount in `src/routes/users.ts`:
 *   - key `users:{user.id}` when authenticated
 *   - key `users:ip:{ip}` otherwise
 *   - standard 429 envelope + draft-7 RateLimit headers
 */

import request from "supertest";
import express from "express";
import type { Request } from "express";
import { createPerUserRateLimiter } from "../src/middleware/rateLimit";

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

type TestUser = { id?: string; address?: string };

/** Same keying rules as `usersRouter` (low limit for fast tests). */
function usersRateLimiter(limit = 2) {
  return createPerUserRateLimiter({
    windowMs: 60_000,
    limit,
    keyGenerator: (req: Request) => {
      const userId = (req as Request & { user?: TestUser }).user?.id;
      if (typeof userId === "string" && userId.trim().length > 0) {
        return `users:${userId}`;
      }
      return `users:ip:${req.socket?.remoteAddress ?? "unknown"}`;
    },
  });
}

function makeApp(limit = 2) {
  const app = express();
  app.use((req, _res, next) => {
    const userId = req.headers["x-test-user-id"];
    if (typeof userId === "string" && userId.trim().length > 0) {
      (req as Request & { user?: TestUser }).user = { id: userId };
    }
    next();
  });
  app.use(usersRateLimiter(limit));
  app.get("/api/users/me", (_req, res) => {
    res.json({ data: { ok: true } });
  });
  app.get("/api/users/:address/profile", (_req, res) => {
    res.json({ data: { ok: true } });
  });
  return app;
}

describe("per-user rate limiting for /api/users", () => {
  it("enforces the limit independently for each authenticated user id", async () => {
    const app = makeApp();

    expect((await request(app).get("/api/users/me").set("x-test-user-id", "user-a")).status).toBe(
      200,
    );
    expect((await request(app).get("/api/users/me").set("x-test-user-id", "user-a")).status).toBe(
      200,
    );
    expect((await request(app).get("/api/users/me").set("x-test-user-id", "user-a")).status).toBe(
      429,
    );

    const otherUser = await request(app).get("/api/users/me").set("x-test-user-id", "user-b");
    expect(otherUser.status).toBe(200);
  });

  it("falls back to a per-IP bucket when no user id is present", async () => {
    const app = makeApp();

    expect((await request(app).get("/api/users/GTEST/profile")).status).toBe(200);
    expect((await request(app).get("/api/users/GTEST/profile")).status).toBe(200);
    expect((await request(app).get("/api/users/GTEST/profile")).status).toBe(429);
  });

  it("does not share the IP bucket with an authenticated user bucket", async () => {
    const app = makeApp();

    // Exhaust anonymous IP bucket
    await request(app).get("/api/users/GTEST/profile");
    await request(app).get("/api/users/GTEST/profile");
    expect((await request(app).get("/api/users/GTEST/profile")).status).toBe(429);

    // Authenticated identity still has its own quota
    const authenticated = await request(app)
      .get("/api/users/me")
      .set("x-test-user-id", "user-isolated");
    expect(authenticated.status).toBe(200);
  });

  it("returns the standard rate-limit error envelope", async () => {
    const app = makeApp();

    await request(app).get("/api/users/me").set("x-test-user-id", "user-envelope");
    await request(app).get("/api/users/me").set("x-test-user-id", "user-envelope");
    const response = await request(app)
      .get("/api/users/me")
      .set("x-test-user-id", "user-envelope");

    expect(response.status).toBe(429);
    expect(response.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      message: "Too many requests",
    });
    expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(response.body.error.retryAfter).toBe(Number(response.headers["retry-after"]));
    expect(typeof response.body.error.resetAt).toBe("string");
  });

  it("exposes IETF draft-7 RateLimit headers on successful responses", async () => {
    const app = makeApp(3);

    const response = await request(app)
      .get("/api/users/me")
      .set("x-test-user-id", "user-headers");

    expect(response.status).toBe(200);
    // express-rate-limit `standardHeaders: "draft-7"` emits a combined RateLimit header.
    const combined =
      response.headers["ratelimit"] ?? response.headers["RateLimit"];
    expect(combined).toBeDefined();
    expect(String(combined)).toMatch(/limit=\d+/i);
    expect(String(combined)).toMatch(/remaining=\d+/i);
  });
});
