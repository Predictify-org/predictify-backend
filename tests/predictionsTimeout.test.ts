/**
 * tests/predictionsTimeout.test.ts
 *
 * Tests for per-request timeout middleware on /api/predictions routes.
 */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "pred-timeout-test-secret-with-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

const authLimit = jest.fn();
const authWhere = jest.fn(() => ({ limit: authLimit }));
const authFrom = jest.fn(() => ({ where: authWhere }));
const authSelect = jest.fn(() => ({ from: authFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: authSelect })),
}));

jest.mock("../src/db/client", () => ({
  db: { select: jest.fn() },
  pool: { on: jest.fn(), end: jest.fn(), query: jest.fn() },
}));

jest.mock("../src/routes/predictions/cancel", () => {
  const { Router } = jest.requireActual("express") as typeof import("express");
  const router = Router();
  return { __esModule: true, default: router };
});

jest.mock("../src/routes/predictions/share", () => ({
  createShareRouter: () => {
    const { Router } = jest.requireActual("express") as typeof import("express");
    return Router();
  },
}));

jest.mock("../src/repositories/predictionRepo");

// ── Imports ──────────────────────────────────────────────────────────────────

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { predictionsRouter } from "../src/routes/predictions";
import { errorHandler } from "../src/middleware/errorHandler";
import { env } from "../src/config/env";
import { listPredictions } from "../src/repositories/predictionRepo";

const mockListPredictions = listPredictions as jest.MockedFunction<typeof listPredictions>;

const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STELLAR_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const MOCK_USER_ROW = { id: TEST_USER_ID, stellarAddress: STELLAR_ADDRESS };

function validToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: STELLAR_ADDRESS, userId },
    env.JWT_SECRET,
    {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: env.JWT_TTL_SECONDS,
    },
  );
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/predictions", predictionsRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

describe("GET /api/predictions — timeout middleware", () => {
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    authWhere.mockReturnValue({ limit: authLimit });
    authFrom.mockReturnValue({ where: authWhere });
    authSelect.mockReturnValue({ from: authFrom });

    // Accelerate only the 15s requestTimeout to 50ms
    global.setTimeout = ((cb: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if (ms === 15000) return originalSetTimeout(cb, 50, ...args);
      return originalSetTimeout(cb, ms, ...args);
    }) as typeof setTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
  });

  it("returns 408 when request exceeds timeout before headers are sent", async () => {
    authLimit.mockResolvedValue([MOCK_USER_ROW]);
    mockListPredictions.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );

    const res = await request(app)
      .get("/api/predictions?limit=5")
      .set("Authorization", `Bearer ${validToken()}`);

    expect(res.status).toBe(408);
    expect(res.body.error.code).toBe("timeout");
    expect(res.body.error.message).toBe("Request timeout exceeded");
  });

  it("completes normally when request finishes within timeout", async () => {
    authLimit.mockResolvedValue([MOCK_USER_ROW]);
    mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

    const res = await request(app)
      .get("/api/predictions?limit=5")
      .set("Authorization", `Bearer ${validToken()}`);

    expect(res.status).toBe(200);
  });
});
