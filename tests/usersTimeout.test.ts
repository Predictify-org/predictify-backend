/**
 * tests/usersTimeout.test.ts
 *
 * Tests for per-request timeout middleware on /api/users.
 * Verifies that the timeout returns 504 Gateway Timeout (as required
 * by issue #604) with cooperative abort.
 */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "users-timeout-test-secret-at-least-32-bytes!!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// Mocks
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

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({
    select: jest.fn(),
  })),
}));

jest.mock("../src/db/client", () => ({
  db: { select: jest.fn() },
  pool: { on: jest.fn(), end: jest.fn() },
}));

jest.mock("../src/middleware/rateLimit", () => ({
  createPerUserRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/metrics/usersMetrics", () => ({
  usersMetricsMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/middleware/accessLog", () => ({
  accessLog: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/middleware/etag", () => ({
  conditionalGet: () => false,
}));

jest.mock("../src/services/userService", () => ({
  __esModule: true,
  listUsers: jest.fn(),
  getUserByAddress: jest.fn(),
  getUserPredictions: jest.fn(),
  getCurrentUserProfile: jest.fn(),
  getUserProfile: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import express from "express";
import request from "supertest";
import { usersRouter } from "../src/routes/users";
import { errorHandler } from "../src/middleware/errorHandler";
import { listUsers } from "../src/services/userService";

const mockListUsers = listUsers as jest.MockedFunction<typeof listUsers>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /api/users — timeout middleware", () => {
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();

    // Accelerate the 15s requestTimeout to 50ms so the test doesn't wait
    global.setTimeout = ((
      cb: (...args: any[]) => void,
      ms?: number,
      ...args: any[]
    ) => {
      if (ms === 15000) return originalSetTimeout(cb, 50, ...args);
      return originalSetTimeout(cb, ms, ...args);
    }) as typeof setTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
  });

  it("returns 504 gateway_timeout when the service hangs past the deadline", async () => {
    mockListUsers.mockImplementation(() => new Promise(() => {}));

    const res = await request(makeApp()).get("/api/users");

    // Debug: log the response body on failure
    if (res.status !== 504) {
      console.log("Unexpected response:", res.status, JSON.stringify(res.body));
    }

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("gateway_timeout");
    expect(res.body.error.message).toBe("Request timed out");
    expect(res.body.error.requestId).toBeDefined();
  });

  it("responds normally with 200 when the service resolves within the deadline", async () => {
    mockListUsers.mockResolvedValue({ data: [], nextCursor: null });

    const res = await request(makeApp()).get("/api/users");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });
});
