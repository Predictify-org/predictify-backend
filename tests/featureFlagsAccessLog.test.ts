/**
 * tests/featureFlagsAccessLog.test.ts
 *
 * Focused unit tests for access logging of /api/feature-flags using src/middleware/accessLog.ts
 */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "access-log-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// Mock pg & drizzle-orm to prevent actual DB socket calls during test setup
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({})),
}));

import * as loggerModule from "../src/config/logger";
const loggerInfoSpy = jest.spyOn(loggerModule.logger, "info").mockImplementation(() => {});

import type { Request, Response, NextFunction } from "express";
import { EventEmitter } from "events";
import { accessLog } from "../src/middleware/accessLog";

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
    path: overrides.path ?? "/api/feature-flags",
    originalUrl: overrides.path ?? "/api/feature-flags",
    ip: overrides.ip ?? "127.0.0.1",
  } as unknown as Request;
}

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

async function fireFinish(res: EventEmitter): Promise<void> {
  res.emit("finish");
  await Promise.resolve();
}

describe("Feature Flags Access Log", () => {
  beforeEach(() => {
    loggerInfoSpy.mockClear();
  });

  it("emits a feature_flags_access_log entry on response finish with all required fields", async () => {
    const req = makeReq({
      headers: { "x-correlation-id": "ff-test-correlation-id" },
      method: "GET",
      path: "/api/feature-flags",
      ip: "192.168.1.1",
    });
    // Set a user on req to verify actor is captured
    (req as any).user = { id: "test-actor-id" };

    const res = makeRes();
    res.setHeader("Content-Length", "100");
    res.statusCode = 200;

    const next: NextFunction = jest.fn();

    accessLog(req, res, next);
    await fireFinish(res);

    expect(next).toHaveBeenCalledTimes(1);
    expect(loggerInfoSpy).toHaveBeenCalledTimes(1);

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "req-id": "ff-test-correlation-id",
        correlationId: "ff-test-correlation-id",
        method: "GET",
        path: "/api/feature-flags",
        statusCode: 200,
        status: 200,
        durationMs: expect.any(Number),
        latency: expect.any(Number),
        ip: "192.168.1.1",
        size: 100,
        actor: "test-actor-id",
      }),
      "feature_flags_access_log",
    );
  });
});
