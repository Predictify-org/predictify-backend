/**
 * Unit tests for POST /api/admin/reindex
 *
 * All external I/O is mocked:
 *   - indexerService          (getCursor, getChainTip, backfillRange)
 *   - auditService            (createAuditLog)
 *   - adminReindexTotal       Prometheus counter
 *
 * The test app is assembled with a low rate-limit cap so the 429 path can be
 * exercised without hammering a real limiter.
 */

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

// ── Mock: indexerService ─────────────────────────────────────────────────────
jest.mock("../src/services/indexerService", () => ({
  indexerService: {
    getCursor: jest.fn(),
    getChainTip: jest.fn(),
    backfillRange: jest.fn(),
  },
}));

// ── Mock: auditService ────────────────────────────────────────────────────────
const mockCreateAuditLog = jest.fn().mockResolvedValue("test-correlation-id");
jest.mock("../src/services/auditService", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));

// ── Mock: Prometheus counter ──────────────────────────────────────────────────
const mockInc = jest.fn();
jest.mock("../src/metrics/registry", () => ({
  adminReindexTotal: { inc: mockInc },
}));

import { indexerService } from "../src/services/indexerService";
import { createAdminReindexRouter } from "../src/routes/admin/reindex";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDR = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR = "GUSER88888888888888888888888888888888888888888888888888888";

const mockedIndexerService = indexerService as jest.Mocked<typeof indexerService>;

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDR, role: "user" });

/**
 * Builds a minimal Express app with the reindex router mounted at
 * /api/admin/reindex.  Pass `rateLimitPerMinute` to override the default 60
 * so tests can easily trigger 429 responses.
 */
function makeApp(rateLimitPerMinute = 60): express.Express {
  const app = express();
  app.use(express.json());

  // Simulate the pino-http request-id injection done in src/index.ts.
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "admin-reindex-req";
    next();
  });

  app.use(
    "/api/admin/reindex",
    createAdminReindexRouter({ rateLimitPerMinute }),
  );
  app.use(errorHandler);
  return app;
}

// ── Reset mocks between tests ─────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockedIndexerService.getCursor.mockResolvedValue(50);
  mockedIndexerService.getChainTip.mockResolvedValue(200);
  mockedIndexerService.backfillRange.mockResolvedValue(undefined);
  mockCreateAuditLog.mockResolvedValue("test-correlation-id");
});

// ── Auth guard ─────────────────────────────────────────────────────────────────

describe("requireAdmin guard", () => {
  it("returns 403 without an Authorization header", async () => {
    const res = await request(makeApp()).post("/api/admin/reindex").send({ ledger: 42 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
    expect(mockedIndexerService.backfillRange).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin JWT", async () => {
    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ ledger: 42 });

    expect(res.status).toBe(403);
    expect(mockedIndexerService.backfillRange).not.toHaveBeenCalled();
  });
});

// ── Input validation ───────────────────────────────────────────────────────────

describe("validation", () => {
  it("rejects a ledger below 1", async () => {
    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(mockedIndexerService.backfillRange).not.toHaveBeenCalled();
  });

  it("rejects a non-integer ledger", async () => {
    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 12.5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(mockedIndexerService.backfillRange).not.toHaveBeenCalled();
  });

  it("rejects a missing ledger field", async () => {
    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────────

describe("POST /api/admin/reindex", () => {
  it("triggers a backfill from the requested ledger to the current chain tip", async () => {
    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "req-reindex")
      .send({ ledger: 42 });

    expect(res.status).toBe(200);
    expect(mockedIndexerService.getChainTip).toHaveBeenCalledTimes(1);
    expect(mockedIndexerService.backfillRange).toHaveBeenCalledWith(42, 200);
    expect(res.body).toEqual(
      expect.objectContaining({
        data: { from: 42, to: 200 },
      }),
    );
  });

  it("echoes the correlation-id in the response header", async () => {
    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "trace-xyz")
      .send({ ledger: 10 });

    expect(res.status).toBe(200);
    // The route sets x-correlation-id (CORRELATION_ID_HEADER), not x-request-id
    expect(res.headers["x-correlation-id"]).toBe("trace-xyz");
  });

  it("records the correct IP in the audit log (single forwarded-for value)", async () => {
    await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Forwarded-For", "203.0.113.5")
      .send({ ledger: 1 });

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.5" }),
    );
  });

  it("writes a structured audit log entry on success", async () => {
    await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "audit-req")
      .send({ ledger: 100 });

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.reindex",
        walletAddress: ADMIN_ADDR,
        correlationId: "audit-req",
      }),
    );
  });

  it("includes beforeState and afterState in the audit log entry", async () => {
    // cursor = 50 (from mock), chainTip = 200 (from mock), from = 42
    await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 42 });

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeState: { cursor: 50, from: 42 },
        afterState: { cursor: 200, from: 42, to: 200 },
      }),
    );
  });

  it("increments the adminReindexTotal Prometheus counter on success", async () => {
    await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 1 });

    expect(mockInc).toHaveBeenCalledTimes(1);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 after the configured limit is exceeded", async () => {
    // Use a limit of 1 so the second request in the window triggers throttling.
    const app = makeApp(1);

    // First request should succeed (uses the 1 allowed slot).
    const first = await request(app)
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 1 });
    expect(first.status).toBe(200);

    // Second request in the same window is throttled.
    const second = await request(app)
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 1 });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });
});

// ── Error propagation ──────────────────────────────────────────────────────────

describe("error propagation", () => {
  it("forwards upstream errors from getChainTip() to the error handler (500)", async () => {
    mockedIndexerService.getChainTip.mockRejectedValue(new Error("rpc unavailable"));

    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 1 });

    // The global errorHandler turns unhandled errors into 500.
    expect(res.status).toBe(500);
    // No audit log or counter should be written when the backfill fails.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
  });

  it("forwards upstream errors from backfillRange() to the error handler (500)", async () => {
    mockedIndexerService.backfillRange.mockRejectedValue(new Error("storage error"));

    const res = await request(makeApp())
      .post("/api/admin/reindex")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 1 });

    expect(res.status).toBe(500);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
  });
});
