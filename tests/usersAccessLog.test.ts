/**
 * tests/usersAccessLog.test.ts
 *
 * Focused unit tests for src/middleware/accessLog.ts
 *
 * Strategy
 * --------
 * The accessLog middleware is tested in pure isolation — no real Express app
 * is spun up and no DB connections are opened.  We construct minimal mock
 * Request / Response / NextFunction objects and drive the middleware directly.
 *
 * Mocking approach
 * ----------------
 * - `pg` and `drizzle-orm/node-postgres` are mocked at the top level so that
 *   importing the logger (which transitively loads config/env) does not attempt
 *   to open a Postgres socket during module load.
 * - `../src/config/logger` is replaced with a jest spy so we can assert the
 *   exact structured payload that accessLog emits without polluting stdout.
 *
 * Coverage targets (≥ 90 % on changed lines)
 * -------------------------------------------
 *   ✓ Uses X-Correlation-Id header when present
 *   ✓ Falls back to X-Request-Id when X-Correlation-Id is absent
 *   ✓ Falls back to req.id when both headers are absent
 *   ✓ Generates a fresh UUID when no source is available
 *   ✓ Sanitises / rejects unsafe characters in client-supplied IDs
 *   ✓ Truncates an oversized client-supplied correlation ID
 *   ✓ Sets res.locals.correlationId
 *   ✓ Sets X-Correlation-Id response header
 *   ✓ Calls next() unconditionally
 *   ✓ Emits users_access_log on res "finish" with all required fields
 *   ✓ Logs correct statusCode for 4xx responses
 *   ✓ Resolves IP from X-Forwarded-For when present
 *   ✓ Falls back to req.ip when X-Forwarded-For is absent
 */

// ---------------------------------------------------------------------------
// 1. Env vars — must be set before ANY project import.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal"; // silence real log output during tests
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "access-log-test-secret-at-least-32-bytes!!";
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
import type { Request, Response, NextFunction } from "express";
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
}> = {}): Request {
  return {
    headers: overrides.headers ?? {},
    id: overrides.id,
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/users/me",
    originalUrl: overrides.path ?? "/api/users/me",
    ip: overrides.ip ?? "127.0.0.1",
    // Express adds query, params, etc. — not needed for accessLog
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
  // Let any synchronous .on("finish") handlers run.
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accessLog middleware", () => {
  beforeEach(() => {
    loggerInfoSpy.mockClear();
  });

  // ── Correlation-ID resolution ──────────────────────────────────────────

  it("uses X-Correlation-Id header when present", () => {
    const req = makeReq({ headers: { "x-correlation-id": "client-trace-abc" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res.locals.correlationId).toBe("client-trace-abc");
    expect(res._headers["X-Correlation-Id"]).toBe("client-trace-abc");
  });

  it("falls back to X-Request-Id when X-Correlation-Id is absent", () => {
    const req = makeReq({ headers: { "x-request-id": "proxy-req-123" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res.locals.correlationId).toBe("proxy-req-123");
    expect(res._headers["X-Correlation-Id"]).toBe("proxy-req-123");
  });

  it("falls back to req.id when both correlation headers are absent", () => {
    const req = makeReq({ id: "pino-req-id-456" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res.locals.correlationId).toBe("pino-req-id-456");
  });

  it("generates a UUID when no correlation source is available", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    const id = res.locals.correlationId as string;
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sanitises unsafe characters from a client-supplied correlation ID", () => {
    const req = makeReq({ headers: { "x-correlation-id": "id with spaces\nnewline<script>" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    // Spaces, newlines, and < > are stripped; alphanumeric + hyphens remain
    const id = res.locals.correlationId as string;
    expect(id).not.toMatch(/[\s<>]/);
    expect(id.length).toBeGreaterThan(0);
  });

  it("truncates an oversized client-supplied correlation ID to 128 chars", () => {
    const longId = "a".repeat(200);
    const req = makeReq({ headers: { "x-correlation-id": longId } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect((res.locals.correlationId as string).length).toBeLessThanOrEqual(128);
  });

  it("falls through to UUID when client-supplied ID is all unsafe characters", () => {
    const req = makeReq({ headers: { "x-correlation-id": "!!!###$$$" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    // All chars stripped → falls through to UUID
    const id = res.locals.correlationId as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // ── Response header ────────────────────────────────────────────────────

  it("echoes the correlation ID in the X-Correlation-Id response header", () => {
    const req = makeReq({ headers: { "x-correlation-id": "echo-me-789" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res._headers["X-Correlation-Id"]).toBe("echo-me-789");
  });

  // ── next() call ────────────────────────────────────────────────────────

  it("always calls next() so the handler chain continues", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error argument
  });

  // ── Structured log on finish ───────────────────────────────────────────

  it("emits a users_access_log entry on response finish with all required fields", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "log-test-id" },
      method: "GET",
      path: "/api/users/me",
      ip: "10.0.0.1",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "req-id": "log-test-id",
        correlationId: "log-test-id",
        method: "GET",
        path: "/api/users/me",
        statusCode: 200,
        status: 200,
        ip: "10.0.0.1",
        durationMs: expect.any(Number),
        latency: expect.any(Number),
        size: 0,
        actor: "anonymous",
      }),
      "users_access_log",
    );
  });

  it("logs the correct statusCode for a 404 response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "not-found-id" } });
    const res = makeRes();
    res.statusCode = 404;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, correlationId: "not-found-id" }),
      "users_access_log",
    );
  });

  it("emits an auth_access_log entry when originalUrl starts with /api/auth", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "auth-log-test-id" },
      method: "POST",
      path: "/api/auth/challenge",
      ip: "10.0.0.1",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "auth-log-test-id",
        method: "POST",
        path: "/api/auth/challenge",
        statusCode: 200,
        ip: "10.0.0.1",
        durationMs: expect.any(Number),
      }),
      "auth_access_log",
    );
  });

  it("emits a predictions_access_log entry when originalUrl starts with /api/predictions", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "predictions-log-test-id" },
      method: "GET",
      path: "/api/predictions",
      ip: "10.0.0.2",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "predictions-log-test-id",
        method: "GET",
        path: "/api/predictions",
        statusCode: 200,
        ip: "10.0.0.2",
        durationMs: expect.any(Number),
      }),
      "predictions_access_log",
    );
  });

  it("emits a markets_access_log entry when originalUrl starts with /api/markets", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "markets-log-test-id" },
      method: "GET",
      path: "/api/markets",
      ip: "10.0.0.3",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "markets-log-test-id",
        method: "GET",
        path: "/api/markets",
        statusCode: 200,
        ip: "10.0.0.3",
        durationMs: expect.any(Number),
      }),
      "markets_access_log",
    );
  });

  it("emits a tags_access_log entry when originalUrl starts with /api/tags", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "tags-log-test-id" },
      method: "GET",
      path: "/api/tags",
      ip: "10.0.0.4",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "tags-log-test-id",
        method: "GET",
        path: "/api/tags",
        statusCode: 200,
        ip: "10.0.0.4",
        durationMs: expect.any(Number),
        "req-id": "tags-log-test-id",
        status: 200,
        latency: expect.any(Number),
        size: 0,
        actor: "anonymous",
      }),
      "tags_access_log",
    );
  });

  it("logs the correct statusCode for a 400 response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "bad-req-id" } });
    const res = makeRes();
    res.statusCode = 400;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
      "users_access_log",
    );
  });

  it("logs the correct statusCode for a 500 response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "server-err-id" } });
    const res = makeRes();
    res.statusCode = 500;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
      "users_access_log",
    );
  });

  it("includes a non-negative durationMs in the log entry", async () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    expect((payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── IP resolution ──────────────────────────────────────────────────────

  it("extracts the first IP from X-Forwarded-For header", async () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      ip: "10.0.0.1",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.5" }),
      "users_access_log",
    );
  });

  it("falls back to req.ip when X-Forwarded-For is absent", async () => {
    const req = makeReq({ ip: "192.168.1.100" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "192.168.1.100" }),
      "users_access_log",
    );
  });

  it("logs 'unknown' when req.ip is undefined and no forwarded header", async () => {
    const req = makeReq();
    (req as unknown as { ip: undefined }).ip = undefined;
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "unknown" }),
      "users_access_log",
    );
  });

  // ── Content-Length / size ──────────────────────────────────────────────

  it("logs the Content-Length when set on the response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "size-test-id" } });
    const res = makeRes();
    res.setHeader("Content-Length", "512");
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ size: 512 }),
      "users_access_log",
    );
  });

  it("logs size=0 when Content-Length is absent", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "no-size-id" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0 }),
      "users_access_log",
    );
  });

  // ── Actor extraction ───────────────────────────────────────────────────

  it("logs the authenticated actor when req.user is set", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "actor-test-id" },
      method: "POST",
      path: "/api/users/me",
    });
    (req as any).user = { id: "authenticated-user-id" };
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "authenticated-user-id" }),
      "users_access_log",
    );
  });

  // ── referrals_access_log ──────────────────────────────────────────────

  it("emits a referrals_access_log entry when originalUrl starts with /api/referrals", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "ref-log-test-id" },
      method: "POST",
      path: "/api/referrals",
      ip: "10.0.0.5",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "ref-log-test-id",
        method: "POST",
        path: "/api/referrals",
        statusCode: 200,
        ip: "10.0.0.5",
        durationMs: expect.any(Number),
      }),
      "referrals_access_log",
    );
  });
});
