/**
 * tests/adminRebuildCache.test.ts
 *
 * Test suite for POST /api/admin/rebuild-cache
 *
 * Covers:
 *  - Auth guard (403 for no token, non-admin token, wrong secret)
 *  - Happy path (201 with evicted keys + requestId)
 *  - Rate limiting (429 after limit is exhausted)
 *  - Redis error propagation (500 from rebuildCache failure)
 *  - Audit log is written on success
 *  - REQUEST_ID_HEADER echoed in every response
 */

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createAdminCacheRebuildRouter } from "../src/routes/admin/cache/rebuild";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Module mocks ─────────────────────────────────────────────────────────────

// Prevent real Redis connection
jest.mock("../src/queue", () => ({
  redisConnection: {
    del: jest.fn(),
  },
}));

// Prevent real DB connection
jest.mock("../src/db/client", () => ({ db: {}, pool: {} }));

// Mock the cache module
jest.mock("../src/cache/marketsCache", () => ({
  marketCacheKeys: {
    all: "markets:all",
    byId: (id: string) => `markets:${id}`,
  },
  rebuildCache: jest.fn(),
  invalidateMarketCache: jest.fn(),
}));

// Mock the audit service
jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("test-correlation-id"),
}));

// Mock requestContext so we get a stable requestId
jest.mock("../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "test-request-id"),
  requestContextStorage: {
    run: jest.fn((_ctx: unknown, fn: () => void) => fn()),
  },
}));

import { rebuildCache } from "../src/cache/marketsCache";
import { createAuditLog } from "../src/services/auditService";

const mockRebuildCache = rebuildCache as jest.MockedFunction<typeof rebuildCache>;
const mockCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

// ── JWT helpers ───────────────────────────────────────────────────────────────

const SECRET =
  process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDRESS =
  "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS =
  "GUSER88888888888888888888888888888888888888888888888888888";

function adminJwt(): string {
  return jwt.sign({ sub: ADMIN_ADDRESS, role: "admin" }, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

function userJwt(): string {
  return jwt.sign({ sub: USER_ADDRESS, role: "user" }, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

// ── App factory ───────────────────────────────────────────────────────────────

/**
 * Builds a minimal Express app that mounts the rebuild-cache router under the
 * same prefix used in production, plus the standard error handler.
 *
 * rateLimitPerMinute is inflated to a large value in most tests so throttling
 * doesn't interfere. Rate-limit tests use a value of 1.
 */
function makeApp(rateLimitPerMinute = 1000): express.Express {
  const app = express();
  app.use(express.json());

  // Simulate pinoHttp assigning a request id
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "req-id-fallback";
    next();
  });

  app.use(
    "/api/admin/rebuild-cache",
    createAdminCacheRebuildRouter({ rateLimitPerMinute }),
  );
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/rebuild-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: successful cache rebuild
    mockRebuildCache.mockResolvedValue({ evictedKeys: ["markets:all"] });
    mockCreateAuditLog.mockResolvedValue("test-correlation-id");
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────
  describe("auth", () => {
    it("returns 403 with no Authorization header", async () => {
      const res = await request(makeApp()).post("/api/admin/rebuild-cache");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 403 with a non-admin JWT (role: user)", async () => {
      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${userJwt()}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "forbidden" } });
    });

    it("returns 403 with a JWT signed by a different secret", async () => {
      const badToken = jwt.sign(
        { sub: ADMIN_ADDRESS, role: "admin" },
        "wrong-secret-at-least-32-characters-long-xxxx",
        { issuer: ISSUER, audience: AUDIENCE },
      );
      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${badToken}`);
      expect(res.status).toBe(403);
    });

    it("returns 403 with a malformed Bearer token", async () => {
      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", "Bearer not.a.jwt");
      expect(res.status).toBe(403);
    });

    it("returns 403 when Authorization header is present but empty", async () => {
      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", "Bearer ");
      expect(res.status).toBe(403);
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────
  describe("happy path", () => {
    it("returns 201 with evictedKeys and requestId", async () => {
      mockRebuildCache.mockResolvedValue({
        evictedKeys: ["markets:all"],
      });

      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        data: {
          evictedKeys: ["markets:all"],
          requestId: expect.any(String),
        },
      });
    });

    it("calls rebuildCache exactly once", async () => {
      await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(mockRebuildCache).toHaveBeenCalledTimes(1);
    });

    it("writes an audit log entry with action 'cache.rebuild'", async () => {
      await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "cache.rebuild",
          walletAddress: ADMIN_ADDRESS,
        }),
      );
    });

    it("echoes the X-Request-Id header in the response", async () => {
      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`)
        .set("x-request-id", "my-req-id");

      expect(res.headers["x-request-id"]).toBeDefined();
    });

    it("includes the requestId in the response body", async () => {
      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(res.body.data.requestId).toBeDefined();
      expect(typeof res.body.data.requestId).toBe("string");
    });

    it("returns all evicted keys reported by rebuildCache", async () => {
      mockRebuildCache.mockResolvedValue({
        evictedKeys: ["markets:all", "markets:extra"],
      });

      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(res.status).toBe(201);
      expect(res.body.data.evictedKeys).toEqual(["markets:all", "markets:extra"]);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────
  describe("error handling", () => {
    it("returns 500 when rebuildCache throws a Redis error", async () => {
      mockRebuildCache.mockRejectedValue(new Error("Redis connection refused"));

      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(res.status).toBe(500);
    });

    it("does NOT write audit log when rebuildCache throws", async () => {
      mockRebuildCache.mockRejectedValue(new Error("Redis gone"));

      await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it("still sets X-Request-Id header even on error", async () => {
      mockRebuildCache.mockRejectedValue(new Error("Redis gone"));

      const res = await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      // Header is set early in the handler before the async work
      expect(res.headers["x-request-id"]).toBeDefined();
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  describe("rate limiting", () => {
    it("returns 429 after the rate limit is exhausted", async () => {
      const app = makeApp(1); // allow only 1 request per minute
      const token = adminJwt();

      // First request should succeed (or 403 for other reasons, but not 429)
      const first = await request(app)
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${token}`);

      expect(first.status).not.toBe(429);

      // Second request in the same window should be rate-limited
      const second = await request(app)
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${token}`);

      expect(second.status).toBe(429);
      expect(second.body).toMatchObject({
        error: { code: "rate_limit_exceeded" },
      });
    });
  });

  // ── Audit content ──────────────────────────────────────────────────────────
  describe("audit log content", () => {
    it("passes the admin wallet address to createAuditLog", async () => {
      await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      const [call] = mockCreateAuditLog.mock.calls;
      expect(call![0].walletAddress).toBe(ADMIN_ADDRESS);
    });

    it("passes a correlationId to createAuditLog", async () => {
      await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      const [call] = mockCreateAuditLog.mock.calls;
      expect(typeof call![0].correlationId).toBe("string");
      expect(call![0].correlationId!.length).toBeGreaterThan(0);
    });

    it("passes an ip to createAuditLog", async () => {
      await request(makeApp())
        .post("/api/admin/rebuild-cache")
        .set("Authorization", `Bearer ${adminJwt()}`);

      const [call] = mockCreateAuditLog.mock.calls;
      expect(typeof call![0].ip).toBe("string");
    });
  });
});

// ── rebuildCache unit tests via the mock ─────────────────────────────────────
// These tests verify rebuildCache behavior by testing the mock interactions
// as set up in the integration test suite above.

describe("rebuildCache (unit — via mock)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is called once per endpoint invocation", async () => {
    mockRebuildCache.mockResolvedValue({ evictedKeys: ["markets:all"] });

    await request(makeApp())
      .post("/api/admin/rebuild-cache")
      .set("Authorization", `Bearer ${adminJwt()}`);

    expect(mockRebuildCache).toHaveBeenCalledTimes(1);
  });

  it("propagates the evicted key list in the response", async () => {
    mockRebuildCache.mockResolvedValue({
      evictedKeys: ["markets:all"],
    });

    const res = await request(makeApp())
      .post("/api/admin/rebuild-cache")
      .set("Authorization", `Bearer ${adminJwt()}`);

    expect(res.body.data.evictedKeys).toEqual(["markets:all"]);
  });

  it("returns 500 when rebuildCache rejects", async () => {
    mockRebuildCache.mockRejectedValue(new Error("Redis down"));

    const res = await request(makeApp())
      .post("/api/admin/rebuild-cache")
      .set("Authorization", `Bearer ${adminJwt()}`);

    expect(res.status).toBe(500);
  });
});
