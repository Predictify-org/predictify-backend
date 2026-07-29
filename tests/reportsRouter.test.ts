/**
 * tests/reportsRouter.test.ts
 *
 * Integration tests for the parent /api/reports router.
 *
 * Verifies that:
 *   - Authentication is enforced at the parent level
 *   - Per-user token-bucket rate limiting applies to all sub-routes
 *   - Sub-routes are accessible through the parent router
 */

let mockUserId: string | null = "test-user-id";

jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!mockUserId) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return;
    }
    req.user = { id: mockUserId, stellarAddress: "GTEST" };
    next();
  },
}));

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "test-correlation-id"),
}));

jest.mock("../src/db", () => {
  const mockDb = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    $count: jest.fn(),
  };
  return { db: mockDb };
});

import express from "express";
import request from "supertest";
import { createReportsRouter } from "../src/routes/reports";
import { errorHandler } from "../src/middleware/errorHandler";
import { db } from "../src/db";

const mockDb = db as jest.Mocked<typeof db>;

function makeApp(rateLimitCapacity = 3) {
  const app = express();
  app.use(express.json());
  const router = createReportsRouter({ rateLimit: { capacity: rateLimitCapacity } });
  app.use("/api/reports", router);
  app.use(errorHandler);
  return app;
}

describe("/api/reports parent router", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = "test-user-id";
  });

  it("returns 401 when auth is rejected", async () => {
    mockUserId = null;
    const app = makeApp();

    const res = await request(app).get("/api/reports/scheduled");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("applies rate limiting to sub-routes", async () => {
    const app = makeApp(2);

    mockDb.returning.mockResolvedValue([{
      id: "r1", userId: "user-1", reportType: "predictions",
      schedule: "0 2 * * *", format: "csv", filters: {}, active: true,
      createdAt: new Date(), updatedAt: new Date(),
    }]);

    const body = {
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
    };

    await request(app).post("/api/reports/scheduled").send(body);
    await request(app).post("/api/reports/scheduled").send(body);

    const blocked = await request(app).post("/api/reports/scheduled").send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
  });

  it("sets Retry-After header on rate-limited sub-route", async () => {
    const app = makeApp(1);

    mockDb.returning.mockResolvedValue([{
      id: "r1", userId: "user-1", reportType: "predictions",
      schedule: "0 2 * * *", format: "csv", filters: {}, active: true,
      createdAt: new Date(), updatedAt: new Date(),
    }]);

    const body = {
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
    };

    await request(app).post("/api/reports/scheduled").send(body);

    const blocked = await request(app).post("/api/reports/scheduled").send(body);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("isolates rate limits per user", async () => {
    const app = makeApp(1);

    mockDb.returning.mockResolvedValue([{
      id: "r1", userId: "user-1", reportType: "predictions",
      schedule: "0 2 * * *", format: "csv", filters: {}, active: true,
      createdAt: new Date(), updatedAt: new Date(),
    }]);

    const body = {
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
    };

    mockUserId = "user-1";
    await request(app).post("/api/reports/scheduled").send(body);

    const user1Blocked = await request(app).post("/api/reports/scheduled").send(body);
    expect(user1Blocked.status).toBe(429);

    mockUserId = "user-2";
    const user2Allowed = await request(app).post("/api/reports/scheduled").send(body);
    expect(user2Allowed.status).toBe(201);
  });
});
