/**
 * tests/adminAccessLog.test.ts
 *
 * Focused unit tests for admin access logging using src/middleware/accessLog.ts
 *
 * Strategy
 * --------
 * The accessLog middleware is tested in pure isolation — no real Express app
 * is spun up and no DB connections are opened.  We construct minimal mock
 * Request / Response / NextFunction objects and drive the middleware directly.
 *
 * Test coverage (≥ 90 % on changed lines)
 * ----------------------------------------
 *   ✓ Emits admin_access_log for /api/admin routes
 *   ✓ Correlation ID is preserved (not regenerated)
 *   ✓ Latency is measured and numeric
 *   ✓ Final HTTP status is captured (200, 400, 403, 500)
 *   ✓ Response size is captured via Content-Length
 *   ✓ Response size defaults to 0 when Content-Length is absent
 *   ✓ Actor is correctly identified from req.adminAddress
 *   ✓ Actor falls back to req.user?.id when adminAddress not set
 *   ✓ Actor defaults to "anonymous" when neither is set
 *   ✓ Admin routes with sub-paths still log as admin_access_log
 *   ✓ Sensitive information is not logged
 *   ✓ Error responses still generate complete access logs
 *   ✓ Multiple requests with different IDs get correct corresponding logs
 */

// ---------------------------------------------------------------------------
// 1. Env vars — must be set before ANY project import.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "admin-access-log-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mock pg so no socket is opened during module load.
// ---------------------------------------------------------------------------
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

// ---------------------------------------------------------------------------
// 3. Mock drizzle-orm/node-postgres — prevents any DB calls leaking out.
// ---------------------------------------------------------------------------
jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// 4. Spy on the logger so we can inspect emitted log payloads.
// ---------------------------------------------------------------------------
import * as loggerModule from "../src/config/logger";
const loggerInfoSpy = jest.spyOn(loggerModule.logger, "info").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// 5. Import the middleware under test.
// ---------------------------------------------------------------------------
import type { NextFunction, Request, Response } from "express";
import { EventEmitter } from "events";
import { accessLog } from "../src/middleware/accessLog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal mock Request. */
function makeReq(overrides: Partial<{
  headers: Record<string, string>;
  id: string;
  method: string;
  path: string;
  ip: string;
  adminAddress: string;
}> = {}): Request {
  return {
    headers: overrides.headers ?? {},
    id: overrides.id,
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/admin/users",
    originalUrl: overrides.path ?? "/api/admin/users",
    ip: overrides.ip ?? "127.0.0.1",
    adminAddress: overrides.adminAddress,
  } as unknown as Request;
}

/** Builds a minimal mock Response backed by EventEmitter so we can trigger "finish". */
function makeRes(): Response & { _headers: Record<string, string>; locals: Record<string, unknown> } {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};

  const res = Object.assign(emitter, {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    getHeader(name: string) {
      return headers[name] ?? headers[name.toLowerCase()];
    },
    get(name: string) {
      return this.getHeader(name);
    },
    _headers: headers,
  });

  return res as unknown as Response & { _headers: Record<string, string>; locals: Record<string, unknown> };
}

/** Fires the "finish" event on a mock Response and returns after the micro-task. */
async function fireFinish(res: EventEmitter): Promise<void> {
  res.emit("finish");
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Admin Access Log", () => {
  beforeEach(() => {
    loggerInfoSpy.mockClear();
  });

  // ── A. BASIC SUCCESSFUL REQUEST ────────────────────────────────────────

  it("emits an admin_access_log entry on response finish with all required fields", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "admin-test-correlation-id" },
      method: "GET",
      path: "/api/admin/users",
      ip: "10.0.0.1",
      adminAddress: "GA5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2K3L",
    });
    const res = makeRes();
    res.setHeader("Content-Length", "250");
    res.statusCode = 200;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(next).toHaveBeenCalledTimes(1);
    expect(loggerInfoSpy).toHaveBeenCalledTimes(1);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "req-id": "admin-test-correlation-id",
        correlationId: "admin-test-correlation-id",
        method: "GET",
        path: "/api/admin/users",
        statusCode: 200,
        status: 200,
        durationMs: expect.any(Number),
        latency: expect.any(Number),
        ip: "10.0.0.1",
        size: 250,
        actor: "GA5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2K3L",
      }),
      "admin_access_log",
    );
  });

  // ── B. CORRELATION ID IS PRESERVED ─────────────────────────────────────

  it("preserves a client-supplied X-Correlation-Id without generating a new one", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "client-preserved-id-999" },
      path: "/api/admin/markets",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "client-preserved-id-999",
        "req-id": "client-preserved-id-999",
      }),
      "admin_access_log",
    );
  });

  it("falls back to X-Request-Id when X-Correlation-Id is absent", async () => {
    const req = makeReq({
      headers: { "x-request-id": "proxy-req-555" },
      path: "/api/admin/users",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "proxy-req-555" }),
      "admin_access_log",
    );
  });

  it("generates a UUID when no correlation source is available", async () => {
    const req = makeReq({ path: "/api/admin/flags" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    const id = (payload as { correlationId: string }).correlationId;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // ── C. LATENCY ─────────────────────────────────────────────────────────

  it("includes a non-negative durationMs (latency) in the log entry", async () => {
    const req = makeReq({ path: "/api/admin/feature-flags" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    expect((payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof (payload as { durationMs: number }).durationMs).toBe("number");
    expect(typeof (payload as { latency: number }).latency).toBe("number");
  });

  // ── D. HTTP STATUS ─────────────────────────────────────────────────────

  it("logs the correct status for a successful 200 response", async () => {
    const req = makeReq({ path: "/api/admin/users" });
    const res = makeRes();
    res.statusCode = 200;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200, status: 200 }),
      "admin_access_log",
    );
  });

  it("logs the correct status for a 400 response", async () => {
    const req = makeReq({ path: "/api/admin/users" });
    const res = makeRes();
    res.statusCode = 400;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
      "admin_access_log",
    );
  });

  it("logs the correct status for a 403 forbidden response", async () => {
    const req = makeReq({ path: "/api/admin/users" });
    const res = makeRes();
    res.statusCode = 403;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
      "admin_access_log",
    );
  });

  it("logs the correct status for a 500 server error response", async () => {
    const req = makeReq({ path: "/api/admin/markets" });
    const res = makeRes();
    res.statusCode = 500;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
      "admin_access_log",
    );
  });

  // ── E. RESPONSE SIZE ───────────────────────────────────────────────────

  it("logs the Content-Length when set on the response", async () => {
    const req = makeReq({ path: "/api/admin/audit" });
    const res = makeRes();
    res.setHeader("Content-Length", "1024");
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ size: 1024 }),
      "admin_access_log",
    );
  });

  it("logs size=0 when Content-Length is absent", async () => {
    const req = makeReq({ path: "/api/admin/users" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0 }),
      "admin_access_log",
    );
  });

  it("logs size=0 for empty/non-existent Content-Length", async () => {
    const req = makeReq({ path: "/api/admin/flags" });
    const res = makeRes();
    res.setHeader("Content-Length", "");
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0 }),
      "admin_access_log",
    );
  });

  // ── F. ACTOR ───────────────────────────────────────────────────────────

  it("logs the actor from req.adminAddress when available", async () => {
    const req = makeReq({
      path: "/api/admin/users",
      adminAddress: "GA_ADMIN_ACTOR_123",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "GA_ADMIN_ACTOR_123" }),
      "admin_access_log",
    );
  });

  it("falls back to req.user?.id when adminAddress is not set", async () => {
    const req = makeReq({ path: "/api/admin/markets" });
    (req as any).user = { id: "user-id-fallback-456" };
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "user-id-fallback-456" }),
      "admin_access_log",
    );
  });

  it("defaults to 'anonymous' when neither adminAddress nor user is set", async () => {
    const req = makeReq({ path: "/api/admin/schema-versions" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "anonymous" }),
      "admin_access_log",
    );
  });

  // ── G. SUB-PATHS ───────────────────────────────────────────────────────

  it("logs admin_access_log for all sub-paths under /api/admin", async () => {
    const subPaths = [
      "/api/admin/users/GC123...",
      "/api/admin/markets/456/feature",
      "/api/admin/audit/export",
      "/api/admin/feature-flags/test-flag",
      "/api/admin/schema-versions",
      "/api/admin/rate-limit/inspect",
    ];

    for (const path of subPaths) {
      loggerInfoSpy.mockClear();
      const req = makeReq({ path });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      accessLog(req, res, next);
      await fireFinish(res);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ path }),
        "admin_access_log",
      );
    }
  });

  // ── H. ERROR RESPONSE LOGS ─────────────────────────────────────────────

  it("generates a complete access log for a 403 error", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "error-403-correlation" },
      method: "POST",
      path: "/api/admin/users",
      ip: "10.1.2.3",
      adminAddress: "GA_ERROR_ACTOR",
    });
    const res = makeRes();
    res.statusCode = 403;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "req-id": "error-403-correlation",
        correlationId: "error-403-correlation",
        method: "POST",
        path: "/api/admin/users",
        statusCode: 403,
        status: 403,
        durationMs: expect.any(Number),
        latency: expect.any(Number),
        ip: "10.1.2.3",
        size: 0,
        actor: "GA_ERROR_ACTOR",
      }),
      "admin_access_log",
    );
  });

  it("generates a complete access log for a 400 validation error", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "error-400-correlation" },
      method: "POST",
      path: "/api/admin/markets/disable",
    });
    const res = makeRes();
    res.statusCode = 400;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "req-id": expect.any(String),
        statusCode: 400,
        method: "POST",
        path: "/api/admin/markets/disable",
        size: 0,
        actor: "anonymous",
      }),
      "admin_access_log",
    );
  });

  // ── I. MULTIPLE REQUESTS ───────────────────────────────────────────────

  it("correctly tracks separate correlation IDs for multiple requests", async () => {
    const req1 = makeReq({
      headers: { "x-correlation-id": "multi-req-001" },
      path: "/api/admin/users",
      adminAddress: "ADMIN_A",
    });
    const req2 = makeReq({
      headers: { "x-correlation-id": "multi-req-002" },
      path: "/api/admin/markets",
      adminAddress: "ADMIN_B",
    });

    const res1 = makeRes();
    const res2 = makeRes();
    const next1: NextFunction = jest.fn();
    const next2: NextFunction = jest.fn();

    accessLog(req1, res1, next1);
    accessLog(req2, res2, next2);

    await fireFinish(res1);
    await fireFinish(res2);

    const calls = loggerInfoSpy.mock.calls;
    expect(calls).toHaveLength(2);

    // First call (order not guaranteed, but with sync code it should be req1 then req2)
    const call1 = calls[0]!;
    const call2 = calls[1]!;

    const payload1 = call1[0] as Record<string, unknown>;
    const payload2 = call2[0] as Record<string, unknown>;

    expect(payload1.correlationId).toBe("multi-req-001");
    expect(payload1.actor).toBe("ADMIN_A");
    expect(payload2.correlationId).toBe("multi-req-002");
    expect(payload2.actor).toBe("ADMIN_B");
  });

  // ── J. SENSITIVE DATA — NOT LOGGED ────────────────────────────────────

  it("does not log authorization tokens", async () => {
    const req = makeReq({
      headers: {
        "x-correlation-id": "sensitive-test",
        authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-token-value",
      },
      path: "/api/admin/users",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    // The logger is configured with redact: ["req.headers.authorization", ...]
    // so we check that the payload does not contain the raw token value
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain("secret-token-value");
    expect(payloadStr).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("does not log request body or cookies", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "no-body-log" },
      path: "/api/admin/flags",
    });
    // Add body and cookies to simulate what should NOT be logged
    (req as any).body = { sensitiveData: "should-not-appear" };
    (req as any).cookies = { session: "secret-session-cookie" };
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain("should-not-appear");
    expect(payloadStr).not.toContain("secret-session-cookie");
  });

  // ── K. CORRELATION ID SANITIZATION ─────────────────────────────────────

  it("sanitises unsafe characters from a client-supplied correlation ID", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "admin\n<script>injected</script>" },
      path: "/api/admin/users",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    const id = (payload as { correlationId: string }).correlationId;
    // Newlines, <, > should be stripped
    expect(id).not.toMatch(/[\n<>]/);
  });

  // ── L. RESPONSE HEADER ─────────────────────────────────────────────────

  it("echoes the correlation ID in the X-Correlation-Id response header", () => {
    const req = makeReq({
      headers: { "x-correlation-id": "echo-test-admin" },
      path: "/api/admin/users",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res._headers["X-Correlation-Id"]).toBe("echo-test-admin");
  });
});
