import express from "express";
import request from "supertest";
import { rateLimitRouter } from "../../src/routes/rate-limit";
import { requestContextStorage } from "../../src/lib/requestContext";
import { anonRateLimitStore, createRateLimitAnon } from "../../src/middleware/rateLimitAnon";

jest.mock("../../src/middleware/requireAdmin", () => ({
  requireAdmin: jest.fn((_req: any, _res: any, next: any) => {
    next();
  }),
}));

jest.mock("../../src/repositories/auditLogRepo");

jest.mock("../../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../src/metrics/registry", () => {
  const actual = jest.requireActual("../../src/metrics/registry");
  return {
    ...actual,
    rateLimitRequestDuration: {
      observe: jest.fn(),
    },
  };
});

import { getAuditLogs } from "../../src/repositories/auditLogRepo";

const mockGetAuditLogs = getAuditLogs as jest.MockedFunction<typeof getAuditLogs>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "test-req-id" }, next);
  });
  app.use("/api/rate-limit", rateLimitRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  jest.clearAllMocks();
  anonRateLimitStore.clear();
});

describe("GET /api/rate-limit — admin listing snapshot", () => {
  it("should maintain a stable response shape for a successful paginated response", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [
        {
          id: "log-1",
          action: "rate_limit.blocked",
          walletAddress: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
          ip: "192.168.1.1",
          correlationId: "corr-1",
          rateLimitContext: null,
          createdAt: new Date("2026-07-28T10:00:00.000Z"),
        },
      ],
      nextCursor: "eyJzb3J0VmFsdWUiOiIyMDI2LTA3LTI4VDEwOjAwOjAwLjAwMFoifQ==",
    });

    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(response.status).toBe(200);
    expect(response.body).toMatchSnapshot();
  });

  it("should maintain a stable validation error shape", async () => {
    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ limit: "not-a-number" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchSnapshot();
  });

  it("should maintain a stable forbidden error shape when unauthenticated", async () => {
    const mockRequireAdmin = jest.requireMock("../../src/middleware/requireAdmin").requireAdmin as jest.Mock;
    mockRequireAdmin.mockImplementationOnce((_req: any, res: any, _next: any) => {
      res.status(403).json({ error: { code: "forbidden" } });
    });

    const response = await request(app).get("/api/rate-limit");

    expect(response.status).toBe(403);
    expect(response.body).toMatchSnapshot();
  });

  it("should have the expected top-level fields on success", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(response.body).toHaveProperty("data");
    expect(response.body).toHaveProperty("nextCursor");
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it("should return an empty data array when no audit logs exist", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(response.body.data).toHaveLength(0);
    expect(response.body.nextCursor).toBeNull();
  });
});

describe("GET /api/rate-limit/status — public status snapshot", () => {
  it("should maintain a stable anonymous status shape with zero usage", async () => {
    const response = await request(app).get("/api/rate-limit/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchSnapshot({
      data: { resetAt: expect.any(String) },
    });
  });

  it("should maintain a stable authenticated status shape", async () => {
    const response = await request(app)
      .get("/api/rate-limit/status")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdA");

    expect(response.status).toBe(200);
    expect(response.body).toMatchSnapshot();
  });

  it("should report correct usage after making requests through the real limiter", async () => {
    const localApp = express();
    localApp.use((_req, _res, next) => {
      requestContextStorage.run({ requestId: "test-req-id" }, next);
    });
    localApp.use("/api/rate-limit", rateLimitRouter);
    localApp.use(
      createRateLimitAnon({ windowMs: 60_000, max: 60, store: anonRateLimitStore }),
    );
    localApp.get("/api/markets", (_req, res) => {
      res.json({ data: [] });
    });

    await request(localApp).get("/api/markets");
    await request(localApp).get("/api/markets");

    const response = await request(localApp).get("/api/rate-limit/status");

    expect(response.status).toBe(200);
    expect(response.body.data.used).toBe(2);
    expect(response.body.data.remaining).toBe(58);
  });
});
