import request from "supertest";
import express from "express";
import { anonRateLimitStore, createRateLimitAnon } from "../src/middleware/rateLimitAnon";
import { rateLimitStatusRouter } from "../src/routes/rate-limit/status";
import { requestContextStorage } from "../src/lib/requestContext";

function makeApp() {
  const app = express();
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "test-req-id" }, next);
  });
  app.use("/api/rate-limit", rateLimitStatusRouter);
  return app;
}

function makeAppWithLimiter(limit = 3, windowMs = 60_000) {
  const app = express();
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "test-req-id" }, next);
  });
  // Mount status route BEFORE the limiter so status queries don't count against the limit
  app.use("/api/rate-limit", rateLimitStatusRouter);
  app.use(
    createRateLimitAnon({ windowMs, max: limit, store: anonRateLimitStore }),
  );
  app.get("/api/markets", (_req, res) => {
    res.json({ data: [] });
  });
  return app;
}

describe("GET /api/rate-limit/status", () => {
  beforeEach(() => {
    anonRateLimitStore.clear();
  });

  it("returns anonymous status with zero usage", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/rate-limit/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: {
        type: "anonymous",
        limit: 60,
        used: 0,
        remaining: 60,
        windowMs: 60000,
      },
    });
    expect(res.body.data.clientIp).toBe("127.0.0.1");
    expect(res.body.data.resetAt).toBeDefined();
    expect(typeof res.body.data.resetAt).toBe("string");
  });

  it("returns correct usage after making requests through the limiter", async () => {
    const app = makeAppWithLimiter(5, 60_000);

    await request(app).get("/api/markets");
    await request(app).get("/api/markets");
    await request(app).get("/api/markets");

    const res = await request(app).get("/api/rate-limit/status");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      type: "anonymous",
      used: 3,
      windowMs: 60000,
    });
    // limit / remaining come from env, not the limiter's per-route config.
    // The key assertion is that `used` reflects the shared store consumption.
    expect(res.body.data.limit).toBe(60);
    expect(res.body.data.remaining).toBe(57);
  });

  it("shows reduced remaining after requests are made", async () => {
    const app = makeAppWithLimiter(60, 60_000);

    await request(app).get("/api/markets");
    await request(app).get("/api/markets");

    const res = await request(app).get("/api/rate-limit/status");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      type: "anonymous",
      used: 2,
      limit: 60,
      remaining: 58,
    });
  });

  it("returns authenticated status for Bearer-authenticated callers", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/rate-limit/status")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdA");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: {
        type: "authenticated",
        limit: 60,
        windowMs: 60000,
        bypasses: true,
      },
    });
  });

  it("returns authenticated status for Bearer-authenticated callers after anonymous requests", async () => {
    const app = makeAppWithLimiter(3, 60_000);

    await request(app).get("/api/markets");
    await request(app).get("/api/markets");

    const res = await request(app)
      .get("/api/rate-limit/status")
      .set("Authorization", "Bearer some-token");

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("authenticated");
    expect(res.body.data.bypasses).toBe(true);
  });

  it("includes resetAt that is a valid ISO date string", async () => {
    const app = makeAppWithLimiter(3, 60_000);

    await request(app).get("/api/markets");

    const res = await request(app).get("/api/rate-limit/status");
    const parsed = new Date(res.body.data.resetAt);
    expect(parsed.toISOString()).toBe(res.body.data.resetAt);
  });
});