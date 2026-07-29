/**
 * tests/tokenBucketRateLimit.test.ts
 *
 * Unit tests for createPerUserTokenBucketLimiter from src/middleware/rateLimit.
 *
 * Coverage targets:
 *   - Token consumption on allowed requests
 *   - 429 response with Retry-After when bucket is exhausted
 *   - RateLimit-* response headers on both success and block
 *   - Token refill over time
 *   - Per-user isolation via key generator
 *   - Fallback to IP-based key for unauthenticated requests
 *   - Audit log on block
 *   - Correlation ID assignment
 */

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import request from "supertest";
import express from "express";
import { createPerUserTokenBucketLimiter } from "../src/middleware/rateLimit";
import { createAuditLog } from "../src/services/auditService";

const mockCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

function makeApp(
  opts: { capacity?: number; refillWindowMs?: number; keyGenerator?: (req: express.Request) => string } = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    const user = req.headers["x-test-user"];
    if (typeof user === "string") {
      (req as typeof req & { user?: { id?: string; address?: string } }).user = { id: user };
    }
    next();
  });
  app.use(
    createPerUserTokenBucketLimiter({
      capacity: opts.capacity ?? 3,
      refillWindowMs: opts.refillWindowMs ?? 60_000,
      keyGenerator: opts.keyGenerator,
    }),
  );
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("createPerUserTokenBucketLimiter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows requests within capacity", async () => {
    const app = makeApp({ capacity: 3 });

    const r1 = await request(app).get("/").set("x-test-user", "user-1");
    expect(r1.status).toBe(200);

    const r2 = await request(app).get("/").set("x-test-user", "user-1");
    expect(r2.status).toBe(200);

    const r3 = await request(app).get("/").set("x-test-user", "user-1");
    expect(r3.status).toBe(200);
  });

  it("returns 429 when bucket is exhausted", async () => {
    const app = makeApp({ capacity: 2 });

    await request(app).get("/").set("x-test-user", "user-1");
    await request(app).get("/").set("x-test-user", "user-1");

    const blocked = await request(app).get("/").set("x-test-user", "user-1");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
  });

  it("sets Retry-After header on 429", async () => {
    const app = makeApp({ capacity: 1 });

    await request(app).get("/").set("x-test-user", "user-1");

    const blocked = await request(app).get("/").set("x-test-user", "user-1");
    expect(blocked.status).toBe(429);

    const retryAfter = blocked.headers["retry-after"];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(blocked.body.error.retryAfter).toBe(Number(retryAfter));
  });

  it("sets RateLimit-* headers on successful requests", async () => {
    const app = makeApp({ capacity: 5 });

    const res = await request(app).get("/").set("x-test-user", "user-1");
    expect(res.status).toBe(200);

    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect(Number(res.headers["ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
    expect(res.headers["ratelimit-reset"]).toBeDefined();
  });

  it("sets RateLimit-* headers on 429 responses", async () => {
    const app = makeApp({ capacity: 1 });

    await request(app).get("/").set("x-test-user", "user-1");

    const blocked = await request(app).get("/").set("x-test-user", "user-1");
    expect(blocked.status).toBe(429);

    expect(blocked.headers["ratelimit-limit"]).toBe("1");
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["ratelimit-reset"]).toBeDefined();
  });

  it("isolates buckets per user key", async () => {
    const app = makeApp({ capacity: 1 });

    await request(app).get("/").set("x-test-user", "user-1");
    const user1Blocked = await request(app).get("/").set("x-test-user", "user-1");
    expect(user1Blocked.status).toBe(429);

    const user2Allowed = await request(app).get("/").set("x-test-user", "user-2");
    expect(user2Allowed.status).toBe(200);
  });

  it("falls back to IP-based key for unauthenticated requests", async () => {
    const app = makeApp({ capacity: 1 });

    await request(app).get("/");
    const blocked = await request(app).get("/");
    expect(blocked.status).toBe(429);
  });

  it("uses custom keyGenerator when provided", async () => {
    const keyGenerator = jest.fn().mockReturnValue("custom-key");
    const app = makeApp({ capacity: 1, keyGenerator });

    await request(app).get("/").set("x-test-user", "user-1");
    expect(keyGenerator).toHaveBeenCalled();

    const blocked = await request(app).get("/").set("x-test-user", "user-1");
    expect(blocked.status).toBe(429);
  });

  it("creates an audit log entry on rate limit block", async () => {
    const app = makeApp({ capacity: 1 });

    await request(app).get("/").set("x-test-user", "user-1");
    await request(app).get("/").set("x-test-user", "user-1");

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rate_limit.blocked",
      }),
    );
  });

  it("includes resetAt in the 429 error body", async () => {
    const app = makeApp({ capacity: 1 });

    await request(app).get("/").set("x-test-user", "user-1");
    const blocked = await request(app).get("/").set("x-test-user", "user-1");

    expect(blocked.body.error.resetAt).toBeDefined();
    expect(new Date(blocked.body.error.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refills tokens after time passes", async () => {
    const app = makeApp({ capacity: 2, refillWindowMs: 1000 });

    await request(app).get("/").set("x-test-user", "user-1");
    await request(app).get("/").set("x-test-user", "user-1");

    const blocked = await request(app).get("/").set("x-test-user", "user-1");
    expect(blocked.status).toBe(429);

    // Wait for tokens to refill (1000ms window, 2 tokens → 500ms per token)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const allowed = await request(app).get("/").set("x-test-user", "user-1");
    expect(allowed.status).toBe(200);
  });

  it("assigns a correlationId to the request", async () => {
    const app = makeApp({ capacity: 3 });

    app.get("/check-cid", (req, res) => {
      const cid = (req as express.Request & { correlationId?: string }).correlationId;
      res.json({ correlationId: cid });
    });

    const res = await request(app).get("/check-cid").set("x-test-user", "user-1");
    expect(res.body.correlationId).toBeDefined();
    expect(typeof res.body.correlationId).toBe("string");
  });
});
