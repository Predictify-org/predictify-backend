// ---------------------------------------------------------------------------
// 1. Env vars (must run BEFORE project imports)
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3002";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "markets-rate-limit-test-secret-at-least-32!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";

// ---------------------------------------------------------------------------
// 2. Mock the audit service (called by the rate-limit middleware on 429).
// ---------------------------------------------------------------------------
jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// 3. Imports
// ---------------------------------------------------------------------------
import express, { type RequestHandler } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createPerUserRateLimiter } from "../src/middleware/rateLimit";

const TEST_SECRET = process.env.JWT_SECRET!;

/** Sign a valid access token (used for per-user rate limit key extraction). */
function signToken(sub: string): string {
  return jwt.sign({ sub }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expiresIn: 3600,
  });
}

// ---------------------------------------------------------------------------
// App factory for per-user rate-limit isolation tests.
// Uses a low limit so we don't need 60+ requests.
// ---------------------------------------------------------------------------
function makeLowLimitApp(
  limit: number = 3,
  limiter?: RequestHandler,
): express.Express {
  const app = express();
  app.set("trust proxy", true);

  const perUserLimiter =
    limiter ??
    createPerUserRateLimiter({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) => {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          const decoded = jwt.decode(token);
          if (decoded && typeof decoded === "object" && decoded.sub) {
            return `markets:user:${decoded.sub}`;
          }
        }
        return `markets:ip:${req.ip ?? "unknown"}`;
      },
    });

  // Only engage for Bearer-token requests.
  app.use((req, res, next) => {
    if (req.headers.authorization?.startsWith("Bearer ")) {
      return perUserLimiter(req, res, next);
    }
    next();
  });

  app.get("/api/markets", (_req, res) => {
    res.json({ data: [] });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("per-user rate limiting for markets", () => {
  // ── Per-user isolation ─────────────────────────────────────────────────

  describe("per-user isolation", () => {
    it("enforces the limit independently for each authenticated user", async () => {
      const app = makeLowLimitApp(3);
      const token1 = `Bearer ${signToken("GUSER11111111111111111111111111111111111111111111111111")}`;
      const token2 = `Bearer ${signToken("GUSER22222222222222222222222222222222222222222222222222")}`;

      // User 1: 3 requests succeed (limit is 3).
      expect(
        (await request(app).get("/api/markets").set("Authorization", token1)).status,
      ).toBe(200);
      expect(
        (await request(app).get("/api/markets").set("Authorization", token1)).status,
      ).toBe(200);
      expect(
        (await request(app).get("/api/markets").set("Authorization", token1)).status,
      ).toBe(200);
      // User 1's 4th request should be blocked.
      const blocked = await request(app)
        .get("/api/markets")
        .set("Authorization", token1);
      expect(blocked.status).toBe(429);

      // User 2: still has their full limit available.
      const otherUser = await request(app)
        .get("/api/markets")
        .set("Authorization", token2);
      expect(otherUser.status).toBe(200);
    });

    it("keys on the JWT sub claim so different subs get separate buckets", async () => {
      const app = makeLowLimitApp(2);
      const tokenA = `Bearer ${signToken("AAAA")}`;
      const tokenB = `Bearer ${signToken("BBBB")}`;

      // Exhaust tokenA's limit.
      await request(app).get("/api/markets").set("Authorization", tokenA);
      await request(app).get("/api/markets").set("Authorization", tokenA);
      expect(
        (await request(app).get("/api/markets").set("Authorization", tokenA)).status,
      ).toBe(429);

      // tokenB should still work (different sub → different bucket).
      expect(
        (await request(app).get("/api/markets").set("Authorization", tokenB)).status,
      ).toBe(200);
    });
  });

  // ── Anonymous users ─────────────────────────────────────────────────────

  describe("anonymous users", () => {
    it("bypass the per-user rate limiter entirely", async () => {
      const app = makeLowLimitApp(1);

      // Even with limit=1, anonymous requests all pass because the
      // per-user limiter only engages for Bearer-token requests.
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get("/api/markets");
        expect(res.status).toBe(200);
      }
    });
  });

  // ── 429 error envelope ─────────────────────────────────────────────────

  describe("429 error envelope", () => {
    it("returns the standard rate-limit error structure", async () => {
      const app = makeLowLimitApp(2);
      const token = `Bearer ${signToken("ENVELOPE-TEST")}`;

      await request(app).get("/api/markets").set("Authorization", token);
      await request(app).get("/api/markets").set("Authorization", token);
      const blocked = await request(app)
        .get("/api/markets")
        .set("Authorization", token);

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("rate_limit_exceeded");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(blocked.body.error.retryAfter).toBe(
        Number(blocked.headers["retry-after"]),
      );
      expect(typeof blocked.body.error.resetAt).toBe("string");
    });

    it("blocked response includes message, retryAfter, and resetAt", async () => {
      const app = makeLowLimitApp(1);
      const token = `Bearer ${signToken("FULL-ENVELOPE")}`;

      await request(app).get("/api/markets").set("Authorization", token);
      const blocked = await request(app)
        .get("/api/markets")
        .set("Authorization", token);

      expect(blocked.body).toEqual({
        error: {
          code: "rate_limit_exceeded",
          message: expect.any(String),
          retryAfter: expect.any(Number),
          resetAt: expect.any(String),
        },
      });
    });
  });

  // ── Rate-limit headers on success ──────────────────────────────────────

  describe("rate-limit headers", () => {
    it("includes draft-7 headers on successful responses", async () => {
      const app = makeLowLimitApp(10);
      const token = `Bearer ${signToken("HEADERS-TEST")}`;

      const res = await request(app)
        .get("/api/markets")
        .set("Authorization", token);

      expect(res.status).toBe(200);
      // express-rate-limit draft-7 emits ratelimit-policy on every response.
      expect(res.headers["ratelimit-policy"]).toBeDefined();
    });
  });
});
