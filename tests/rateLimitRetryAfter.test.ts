/**
 * Tests for the standardized 429 response with Retry-After (#211).
 */
import request from "supertest";
import express from "express";

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createRateLimiter } from "../src/middleware/rateLimit";

function makeApp(): express.Express {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, limit: 1 }));
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rate limit 429 envelope", () => {
  it("sets Retry-After and a structured body once the limit is exceeded", async () => {
    const app = makeApp();

    const first = await request(app).get("/");
    expect(first.status).toBe(200);

    const blocked = await request(app).get("/");
    expect(blocked.status).toBe(429);

    // Retry-After header present and a positive integer number of seconds.
    const retryAfter = blocked.headers["retry-after"];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

    // Structured envelope mirrors the header.
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
    expect(blocked.body.error.retryAfter).toBe(Number(retryAfter));
    expect(typeof blocked.body.error.resetAt).toBe("string");
  });
});
