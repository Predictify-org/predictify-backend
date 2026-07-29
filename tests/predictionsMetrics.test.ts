/**
 * tests/predictionsMetrics.test.ts
 *
 * Tests for per-endpoint metrics on /api/predictions routes.
 */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "pred-metrics-test-secret-with-at-least-32-bytes!!";
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

const mockObserve = jest.fn();
const mockInc = jest.fn();

jest.mock("../src/metrics/registry", () => {
  const actual = jest.requireActual("../src/metrics/registry");
  return {
    ...actual,
    predictionsListTotal: { inc: mockInc },
    predictionExplainTotal: { inc: mockInc },
    predictionsRequestDuration: { observe: mockObserve },
  };
});

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

describe("GET /api/predictions — per-endpoint metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authWhere.mockReturnValue({ limit: authLimit });
    authFrom.mockReturnValue({ where: authWhere });
    authSelect.mockReturnValue({ from: authFrom });
  });

  describe("predictions list metrics", () => {
    it("increments predictionsListTotal on success", async () => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get("/api/predictions")
        .set("Authorization", `Bearer ${validToken()}`);

      const successCalls = mockInc.mock.calls.filter(
        (call: { outcome?: string }[]) => call[0]?.outcome === "success",
      );
      expect(successCalls.length).toBeGreaterThanOrEqual(1);

      const listObserveCalls = mockObserve.mock.calls.filter(
        (call: { handler?: string }[]) => call[0]?.handler === "list",
      );
      expect(listObserveCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("increments predictionsListTotal on validation error", async () => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);

      await request(app)
        .get("/api/predictions?status=invalid_status")
        .set("Authorization", `Bearer ${validToken()}`);

      const errorCalls = mockInc.mock.calls.filter(
        (call: { outcome?: string }[]) => call[0]?.outcome === "error",
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("records duration histogram for list endpoint", async () => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get("/api/predictions")
        .set("Authorization", `Bearer ${validToken()}`);

      const observeCalls = mockObserve.mock.calls.filter(
        (call: { handler?: string }[]) =>
          call[0]?.handler === "list" && call[0]?.outcome === "success",
      );
      expect(observeCalls.length).toBeGreaterThanOrEqual(1);
      expect(observeCalls[0][1]).toBeGreaterThanOrEqual(0);
    });
  });
});
