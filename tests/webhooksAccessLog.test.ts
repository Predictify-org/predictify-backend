/**
 * tests/webhooksAccessLog.test.ts
 *
 * Focused unit tests for structured access logging of /api/webhooks
 * using src/middleware/accessLog.ts
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
 *   ✓ Emits webhooks_access_log entry on response finish with all required fields
 *   ✓ Emits webhooks_access_log for GET, POST, PATCH, DELETE methods
 *   ✓ Logs correlationId from X-Correlation-Id header
 *   ✓ Logs correct statusCode for 2xx, 4xx, 5xx responses
 *   ✓ Logs the actor (user.id) when user is authenticated
 *   ✓ Logs 'anonymous' when no user is attached
 *   ✓ Sets X-Correlation-Id response header for webhooks routes
 *   ✓ Includes durationMs, method, path, ip, size in the log entry
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
  user: { id: string };
}> = {}): Request {
  const req: Record<string, unknown> = {
    headers: overrides.headers ?? {},
    id: overrides.id,
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/webhooks",
    originalUrl: overrides.path ?? "/api/webhooks",
    ip: overrides.ip ?? "127.0.0.1",
    user: overrides.user,
  };
  return req as unknown as Request;
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

describe("Webhooks access log middleware", () => {
  beforeEach(() => {
    loggerInfoSpy.mockClear();
  });

  // ── Log name ───────────────────────────────────────────────────────────

  it("emits a webhooks_access_log entry on response finish", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "wh-test-id" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "wh-test-id",
        method: "GET",
        path: "/api/webhooks",
        statusCode: 200,
        ip: "127.0.0.1",
        durationMs: expect.any(Number),
      }),
      "webhooks_access_log",
    );
  });

  // ── HTTP methods ──────────────────────────────────────────────────────

  it.each(["GET", "POST", "PATCH", "DELETE"])(
    "emits webhooks_access_log for %s requests",
    async (method) => {
      const req = makeReq({ method, headers: { "x-correlation-id": "method-test" } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      accessLog(req, res, next);
      await fireFinish(res);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ method }),
        "webhooks_access_log",
      );
    },
  );

  // ── Correlation ID ────────────────────────────────────────────────────

  it("logs correlationId from X-Correlation-Id header", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "wh-custom-trace" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "wh-custom-trace" }),
      "webhooks_access_log",
    );
  });

  it("falls back to X-Request-Id for webhooks routes", () => {
    const req = makeReq({ headers: { "x-request-id": "proxy-req-999" }, path: "/api/webhooks/123" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res.locals.correlationId).toBe("proxy-req-999");
    expect(res._headers["X-Correlation-Id"]).toBe("proxy-req-999");
  });

  it("generates a UUID when no correlation source is provided for webhooks", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    const id = res.locals.correlationId as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // ── Status codes ──────────────────────────────────────────────────────

  it("logs the correct statusCode for a 200 response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "ok-test" } });
    const res = makeRes();
    res.statusCode = 200;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200 }),
      "webhooks_access_log",
    );
  });

  it("logs the correct statusCode for a 400 response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "bad-req" } });
    const res = makeRes();
    res.statusCode = 400;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
      "webhooks_access_log",
    );
  });

  it("logs the correct statusCode for a 404 response", async () => {
    const req = makeReq({ path: "/api/webhooks/999", headers: { "x-correlation-id": "not-found" } });
    const res = makeRes();
    res.statusCode = 404;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404 }),
      "webhooks_access_log",
    );
  });

  it("logs the correct statusCode for a 500 response", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "err-test" } });
    const res = makeRes();
    res.statusCode = 500;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
      "webhooks_access_log",
    );
  });

  // ── Actor ─────────────────────────────────────────────────────────────

  it("logs the actor (user.id) when user is authenticated", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "actor-test" },
      user: { id: "wh-user-abc-123" },
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "wh-user-abc-123" }),
      "webhooks_access_log",
    );
  });

  it("logs 'anonymous' when no user is attached on the request", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "anon-test" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "anonymous" }),
      "webhooks_access_log",
    );
  });

  // ── Response header ───────────────────────────────────────────────────

  it("sets X-Correlation-Id response header for webhooks routes", () => {
    const req = makeReq({ headers: { "x-correlation-id": "header-echo" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(res._headers["X-Correlation-Id"]).toBe("header-echo");
  });

  // ── Payload fields ────────────────────────────────────────────────────

  it("includes all required fields in the log entry", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "all-fields" },
      method: "POST",
      path: "/api/webhooks",
      ip: "10.0.0.42",
      user: { id: "test-actor" },
    });
    const res = makeRes();
    res.statusCode = 201;
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "req-id": "all-fields",
        correlationId: "all-fields",
        method: "POST",
        path: "/api/webhooks",
        statusCode: 201,
        status: 201,
        durationMs: expect.any(Number),
        latency: expect.any(Number),
        ip: "10.0.0.42",
        size: 0,
        actor: "test-actor",
      }),
      "webhooks_access_log",
    );
  });

  it("includes a non-negative durationMs", async () => {
    const req = makeReq({ headers: { "x-correlation-id": "dur-test" } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    const [[payload]] = loggerInfoSpy.mock.calls;
    expect((payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Sub-path handling ─────────────────────────────────────────────────

  it("emits webhooks_access_log for sub-paths under /api/webhooks", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "sub-path" },
      path: "/api/webhooks/abc-123",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "sub-path" }),
      "webhooks_access_log",
    );
  });

  // ── next() call ──────────────────────────────────────────────────────

  it("always calls next() so the handler chain continues", () => {
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  // ── IP resolution ─────────────────────────────────────────────────────

  it("extracts IP from X-Forwarded-For for webhooks routes", async () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1", "x-correlation-id": "xff-test" },
      ip: "10.0.0.1",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "198.51.100.1" }),
      "webhooks_access_log",
    );
  });

  it("falls back to req.ip when X-Forwarded-For is absent for webhooks", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "ip-fallback" },
      ip: "10.0.0.99",
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "10.0.0.99" }),
      "webhooks_access_log",
    );
  });
});
