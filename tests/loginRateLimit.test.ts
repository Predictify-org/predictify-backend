import request from "supertest";
import express from "express";
import { SlidingWindowStore } from "../src/middleware/rateLimitAnon";
import {
  createLoginRateLimit,
  LoginRateLimitOptions,
} from "../src/middleware/loginRateLimit";
import { requestContextStorage } from "../src/lib/requestContext";

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function makeApp(opts?: Partial<LoginRateLimitOptions>) {
  const windowMs = opts?.windowMs ?? 60_000;
  const max = opts?.max ?? 3;
  const trustProxy = opts?.trustProxy ?? false;
  const store = opts?.store ?? new SlidingWindowStore();
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "test-req-id" }, next);
  });
  app.post(
    "/api/auth/challenge",
    createLoginRateLimit({ windowMs, max, trustProxy, store }),
    (_req, res) => {
      res.status(201).json({ nonce: "abc", expiresAt: new Date().toISOString() });
    },
  );
  app.post(
    "/api/auth/verify",
    createLoginRateLimit({ windowMs, max, trustProxy, store }),
    (_req, res) => {
      res.status(200).json({ accessToken: "mock-token" });
    },
  );
  return { app, store };
}

describe("createLoginRateLimit middleware", () => {
  it("allows requests under the limit", async () => {
    const { app } = makeApp({ max: 5 });
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GDLOOOP" });
    expect(res.status).toBe(201);
  });

  it("returns 429 with Retry-After when the window is exceeded", async () => {
    const { app } = makeApp({ max: 2 });
    await request(app).post("/api/auth/challenge").send({});
    await request(app).post("/api/auth/challenge").send({});
    const res = await request(app).post("/api/auth/challenge").send({});

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "Too many login attempts. Please try again later.",
        retryAfter: expect.any(Number),
        requestId: "test-req-id",
      },
    });
  });

  it("blocks on /api/auth/verify when limit is exceeded", async () => {
    const { app } = makeApp({ max: 1 });
    await request(app).post("/api/auth/verify").send({}).expect(200);
    const res = await request(app).post("/api/auth/verify").send({});
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limit_exceeded");
  });

  it("uses separate buckets for different IPs", async () => {
    const store = new SlidingWindowStore();
    const { app } = makeApp({ max: 1, trustProxy: true, store });

    const req1 = request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.1");
    await req1.send({}).expect(201);

    const req2 = request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.2");
    await req2.send({}).expect(201);

    const req3 = request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.1");
    const blocked = await req3.send({});
    expect(blocked.status).toBe(429);
  });

  it("keys limits by socket IP when trust proxy is disabled", async () => {
    const { app } = makeApp({ max: 1, trustProxy: false });

    await request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.50")
      .send({})
      .expect(201);

    const res = await request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.50")
      .send({});
    expect(res.status).toBe(429);
  });

  it("uses X-Forwarded-For when trust proxy is enabled", async () => {
    const { app } = makeApp({ max: 1, trustProxy: true });

    await request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.99")
      .send({})
      .expect(201);

    const res = await request(app)
      .post("/api/auth/challenge")
      .set("x-forwarded-for", "203.0.113.99")
      .send({});
    expect(res.status).toBe(429);
  });

  it("window slides: requests outside the window do not count", async () => {
    const store = new SlidingWindowStore();
    const windowMs = 100;
    const { app } = makeApp({ max: 2, windowMs, store });

    await request(app).post("/api/auth/challenge").send({}).expect(201);
    await request(app).post("/api/auth/challenge").send({}).expect(201);
    await request(app).post("/api/auth/challenge").send({}).expect(429);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 10));

    const res = await request(app).post("/api/auth/challenge").send({});
    expect(res.status).toBe(201);
  });

  it("returns consistent error envelope on 429", async () => {
    const { app } = makeApp({ max: 1 });
    await request(app).post("/api/auth/challenge").send({});
    const res = await request(app).post("/api/auth/challenge").send({});
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: {
        code: "rate_limit_exceeded",
        message: "Too many login attempts. Please try again later.",
      },
    });
    expect(typeof res.body.error.retryAfter).toBe("number");
    expect(res.body.error.retryAfter).toBeGreaterThan(0);
  });
});
