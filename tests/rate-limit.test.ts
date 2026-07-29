import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { rateLimitRouter } from "../src/routes/rate-limit";
import { requestContextStorage } from "../src/lib/requestContext";
import * as auditLogRepo from "../src/repositories/auditLogRepo";
import { rateLimitRequestDuration, register } from "../src/metrics/registry";

// Mock requireAdmin to just pass through
jest.mock("../src/middleware/requireAdmin", () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (_req as any).adminAddress = "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF";
    next();
  },
}));

jest.mock("../src/repositories/auditLogRepo");

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetAuditLogs = auditLogRepo.getAuditLogs as jest.MockedFunction<
  typeof auditLogRepo.getAuditLogs
>;

// Minimal error-handling middleware for test isolation
function testErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  const status = (err as { status?: number })?.status ?? 500;
  res.status(status).json({ error: { code: status === 500 ? "internal_error" : "request_failed" } });
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const requestId = uuidv4();
      (req as { id?: string }).id = requestId;
      requestContextStorage.run({ requestId }, next);
    },
  );
  app.use("/api/rate-limit", rateLimitRouter);
  app.get("/api/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });
  app.use(testErrorHandler);
  return app;
}

const app = makeApp();

/**
 * Reads the current sample count for a given label subset via the
 * histogram's own `.get()` snapshot (public prom-client API only).
 */
async function sampleCount(
  histogram: typeof rateLimitRequestDuration,
  labels: Record<string, string>,
): Promise<number> {
  const metric = await histogram.get();
  const countSeries = metric.values.find(
    (v) =>
      v.metricName?.endsWith("_count") &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return countSeries?.value ?? 0;
}

describe("GET /api/rate-limit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a paginated list of rate-limit audit logs", async () => {
    const mockData = [
      {
        id: "log-1",
        action: "rate_limit.blocked",
        walletAddress: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
        ip: "192.168.1.1",
        correlationId: "corr-1",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T10:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValueOnce({
      data: mockData,
      nextCursor: null,
    });

    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ limit: "10" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        {
          id: "log-1",
          action: "rate_limit.blocked",
          walletAddress: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
          ip: "192.168.1.1",
          correlationId: "corr-1",
          rateLimitContext: null,
          createdAt: "2026-07-28T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(mockGetAuditLogs).toHaveBeenCalledWith({
      action: "rate_limit.blocked",
      cursor: undefined,
      limit: 10,
    });
  });

  it("returns paginated results with nextCursor", async () => {
    const mockData = Array.from({ length: 3 }, (_, i) => ({
      id: `log-${i}`,
      action: "rate_limit.blocked",
      walletAddress: null,
      ip: `192.168.1.${i}`,
      correlationId: `corr-${i}`,
      rateLimitContext: null,
      createdAt: new Date(`2026-07-28T${10 + i}:00:00Z`),
    }));

    mockGetAuditLogs.mockResolvedValueOnce({
      data: mockData,
      nextCursor: "eyJzb3J0VmFsdWUiOiIyMDI2LTA3LTI4VDEyOjAwOjAwLjAwMFoiLCJpZCI6ImxvZy0yIn0=",
    });

    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ limit: "3" });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(3);
    expect(response.body.nextCursor).toBeDefined();
  });

  it("rejects invalid limit parameter", async () => {
    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ limit: "not-a-number" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects empty cursor parameter", async () => {
    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ cursor: "" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects negative limit", async () => {
    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ limit: "-5" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("returns 500 when getAuditLogs throws", async () => {
    mockGetAuditLogs.mockRejectedValueOnce(new Error("Database error"));

    const response = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(response.status).toBe(500);
  });
});

describe("rate_limit_request_duration_seconds histogram", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is registered with the expected name and explicit buckets", () => {
    expect(rateLimitRequestDuration.name).toBe("rate_limit_request_duration_seconds");
    // @ts-expect-error -- accessing an internal prom-client field
    const buckets: number[] = rateLimitRequestDuration.buckets;
    expect(buckets).toEqual([0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]);
  });

  it("observes a sample labeled route=/ status=200 on a successful request", async () => {
    const mockData = [
      {
        id: "log-metrics-1",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.1",
        correlationId: "metrics-test-1",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValue({
      data: mockData,
      nextCursor: null,
    });

    const before = await sampleCount(rateLimitRequestDuration, {
      route: "/",
      status: "200",
    });

    const res = await request(app).get("/api/rate-limit");
    expect(res.status).toBe(200);

    const after = await sampleCount(rateLimitRequestDuration, {
      route: "/",
      status: "200",
    });
    expect(after).toBe(before + 1);
  });

  it("observes a sample labeled status=500 when the service throws", async () => {
    mockGetAuditLogs.mockRejectedValue(new Error("DB connection lost"));

    const before = await sampleCount(rateLimitRequestDuration, {
      route: "/",
      status: "500",
    });

    const res = await request(app).get("/api/rate-limit");
    expect(res.status).toBe(500);

    const after = await sampleCount(rateLimitRequestDuration, {
      route: "/",
      status: "500",
    });
    expect(after).toBe(before + 1);
  });

  it("increments the sample count by exactly 1 per request", async () => {
    const mockData = [
      {
        id: "log-metrics-2",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.2",
        correlationId: "metrics-test-2",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValue({
      data: mockData,
      nextCursor: null,
    });

    const before = await sampleCount(rateLimitRequestDuration, {
      route: "/",
      status: "200",
    });

    await request(app).get("/api/rate-limit");
    await request(app).get("/api/rate-limit");

    const after = await sampleCount(rateLimitRequestDuration, {
      route: "/",
      status: "200",
    });
    expect(after).toBe(before + 2);
  });

  it("is exposed in Prometheus exposition format via register.metrics()", async () => {
    await request(app).get("/api/rate-limit");

    const metricsRes = await request(app).get("/api/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain(
      "# HELP rate_limit_request_duration_seconds",
    );
    expect(metricsRes.text).toContain(
      "# TYPE rate_limit_request_duration_seconds histogram",
    );
    expect(metricsRes.text).toMatch(
      /rate_limit_request_duration_seconds_bucket\{.*route="\/".*status="200".*\}/,
    );
  });

  it("registers the histogram on the shared prom-client registry", () => {
    expect(register.getSingleMetric("rate_limit_request_duration_seconds")).toBe(
      rateLimitRequestDuration,
    );
  });
});

describe("GET /api/rate-limit – ETag caching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("200 response includes an ETag header", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [
        {
          id: "etag-test-1",
          action: "rate_limit.blocked",
          walletAddress: null,
          ip: "10.0.0.1",
          correlationId: "etag-test",
          rateLimitContext: null,
          createdAt: new Date("2026-07-28T12:00:00Z"),
        },
      ],
      nextCursor: null,
    });

    const res = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("200 response includes Cache-Control: no-cache", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    const res = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches current ETag", async () => {
    const mockData = [
      {
        id: "etag-304-1",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.1",
        correlationId: "etag-304",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValue({
      data: mockData,
      nextCursor: null,
    });

    const first = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    const etag = first.headers["etag"];
    expect(etag).toBeDefined();

    const second = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("304 response has no body", async () => {
    const mockData = [
      {
        id: "etag-nobody-1",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.1",
        correlationId: "etag-nobody",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValue({
      data: mockData,
      nextCursor: null,
    });

    const first = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    const etag = first.headers["etag"];

    const second = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBeFalsy();
  });

  it("304 response still includes ETag header", async () => {
    const mockData = [
      {
        id: "etag-header-1",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.1",
        correlationId: "etag-header",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValue({
      data: mockData,
      nextCursor: null,
    });

    const first = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    const etag = first.headers["etag"];

    const second = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.headers["etag"]).toBe(etag);
  });

  it("returns 200 when If-None-Match is stale (wrong hash)", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [
        {
          id: "stale-1",
          action: "rate_limit.blocked",
          walletAddress: null,
          ip: "10.0.0.1",
          correlationId: "stale-test",
          rateLimitContext: null,
          createdAt: new Date("2026-07-28T12:00:00Z"),
        },
      ],
      nextCursor: null,
    });

    const res = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("returns 200 when If-None-Match header is absent", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    const res = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(res.status).toBe(200);
  });

  it("ETag is stable across repeated requests for the same data", async () => {
    const mockData = [
      {
        id: "stable-1",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.1",
        correlationId: "stable-test",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValue({
      data: mockData,
      nextCursor: null,
    });

    const r1 = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    const r2 = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(r1.headers["etag"]).toBe(r2.headers["etag"]);
  });

  it("ETag changes when the data payload differs", async () => {
    mockGetAuditLogs.mockResolvedValueOnce({
      data: [
        {
          id: "v1",
          action: "rate_limit.blocked",
          walletAddress: null,
          ip: "10.0.0.1",
          correlationId: "v1",
          rateLimitContext: null,
          createdAt: new Date("2026-07-28T12:00:00Z"),
        },
      ],
      nextCursor: null,
    });

    const r1 = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    mockGetAuditLogs.mockResolvedValueOnce({
      data: [
        {
          id: "v2",
          action: "rate_limit.blocked",
          walletAddress: null,
          ip: "10.0.0.2",
          correlationId: "v2",
          rateLimitContext: null,
          createdAt: new Date("2026-07-28T13:00:00Z"),
        },
      ],
      nextCursor: null,
    });

    const r2 = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    expect(r1.headers["etag"]).not.toBe(r2.headers["etag"]);
  });

  it("sends 304 only for the specific resource version", async () => {
    const mockDataV1 = [
      {
        id: "ver-1",
        action: "rate_limit.blocked",
        walletAddress: null,
        ip: "10.0.0.1",
        correlationId: "ver-test",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    const mockDataV2 = [
      {
        id: "ver-1",
        action: "rate_limit.blocked",
        walletAddress: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
        ip: "10.0.0.1",
        correlationId: "ver-test",
        rateLimitContext: null,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      },
    ];

    mockGetAuditLogs.mockResolvedValueOnce({
      data: mockDataV1,
      nextCursor: null,
    });

    const first = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token");

    const staleEtag = first.headers["etag"];

    mockGetAuditLogs.mockResolvedValueOnce({
      data: mockDataV2,
      nextCursor: null,
    });

    const second = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .set("If-None-Match", staleEtag);

    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
  });

  it("400 validation error does not set strong ETag or Cache-Control headers", async () => {
    const res = await request(app)
      .get("/api/rate-limit")
      .set("Authorization", "Bearer valid-admin-token")
      .query({ limit: "not-a-number" });

    expect(res.status).toBe(400);
    // Express sets a weak ETag automatically; our middleware sets a strong
    // SHA-256 ETag only on 200 responses. Verify it is NOT a strong ETag.
    const etag = res.headers["etag"];
    if (etag) {
      expect(etag).not.toMatch(/^"[0-9a-f]{64}"$/);
    }
    // Our middleware sets Cache-Control only on handled payloads.
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});
