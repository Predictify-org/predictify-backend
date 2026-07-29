import request from "supertest";
import express from "express";

jest.resetModules();

jest.doMock("../src/middleware/rateLimit", () => {
  const actual = jest.requireActual("../src/middleware/rateLimit");
  return {
    ...actual,
    createPerUserRateLimiter: (opts: any) =>
      actual.createPerUserRateLimiter({ ...opts, limit: 2 }),
  };
});

jest.doMock("../src/metrics/usersMetrics", () => ({
  usersMetricsMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.doMock("../src/middleware/requireAuth", () => ({
  requireAuthForbidden: (req: any, res: any, next: any) => {
    const userId = req.headers["x-test-user-id"];
    if (typeof userId === "string" && userId.trim().length > 0) {
      req.user = { id: userId };
      return next();
    }
    return res.status(403).json({ error: { code: "forbidden" } });
  },
}));

jest.mock("../src/services/userService", () => ({
  getCurrentUserProfile: jest.fn().mockResolvedValue({
    ok: true,
    value: { stellarAddress: "GTEST", totals: {} },
  }),
  getUserProfile: jest.fn().mockResolvedValue({ predictions: [] }),
}));

import { usersRouter } from "../src/routes/users";

function makeApp() {
  const app = express();
  app.use("/api/users", usersRouter);
  return app;
}

describe("usersRouter rate limit integration", () => {
  it("applies per-user limits to /me", async () => {
    const app = makeApp();

    expect(
      (await request(app).get("/api/users/me").set("x-test-user-id", "u1"))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/users/me").set("x-test-user-id", "u1"))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/users/me").set("x-test-user-id", "u1"))
        .status,
    ).toBe(429);

    // Another user still gets its own quota
    expect(
      (await request(app).get("/api/users/me").set("x-test-user-id", "u2"))
        .status,
    ).toBe(200);
  });
});
