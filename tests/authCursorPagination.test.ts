/**
 * tests/authCursorPagination.test.ts
 *
 * Tests for GET /api/auth cursor pagination endpoint.
 */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "auth-cursor-test-secret-with-at-least-32-bytes!!";
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

jest.mock("../src/middleware/rateLimit", () => ({
  createPerUserRateLimiter: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock("../src/db/client", () => ({
  db: {
    select: jest.fn(),
  },
  pool: { on: jest.fn(), end: jest.fn(), query: jest.fn() },
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authRouter } from "../src/routes/auth";
import { errorHandler } from "../src/middleware/errorHandler";
import { env } from "../src/config/env";
import { db } from "../src/db/client";

const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STELLAR_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const FAMILY_ID_1 = "11111111-1111-1111-1111-111111111111";
const TOKEN_ID_1 = "aaaaaaaa-1111-1111-1111-111111111111";
const TOKEN_ID_2 = "bbbbbbbb-2222-2222-2222-222222222222";

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
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

describe("GET /api/auth — cursor pagination", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authWhere.mockReturnValue({ limit: authLimit });
    authFrom.mockReturnValue({ where: authWhere });
    authSelect.mockReturnValue({ from: authFrom });
  });

  describe("authentication", () => {
    it("returns 401 when no Authorization header is present", async () => {
      const res = await request(app).get("/api/auth");
      expect(res.status).toBe(401);
    });

    it("returns 401 with an invalid JWT", async () => {
      const res = await request(app)
        .get("/api/auth")
        .set("Authorization", "Bearer invalid-token");
      expect(res.status).toBe(401);
    });
  });

  describe("happy path", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns empty data when no sessions exist", async () => {
      const limitMock = jest.fn().mockResolvedValue([]);
      const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth")
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });

    it("returns sessions with nextCursor when there are more", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const pastDate = new Date("2026-01-01T00:00:00.000Z");

      const rows = [
        { id: TOKEN_ID_1, familyId: FAMILY_ID_1, createdAt: pastDate, expiresAt: futureDate },
        { id: TOKEN_ID_2, familyId: FAMILY_ID_1, createdAt: pastDate, expiresAt: futureDate },
      ];
      const limitMock = jest.fn().mockResolvedValue(rows);
      const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth?limit=1")
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it("returns nextCursor = null on the last page", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const pastDate = new Date("2026-01-01T00:00:00.000Z");

      const rows = [
        { id: TOKEN_ID_1, familyId: FAMILY_ID_1, createdAt: pastDate, expiresAt: futureDate },
      ];
      const limitMock = jest.fn().mockResolvedValue(rows);
      const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth?limit=5")
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
    });

    it("serializes dates as ISO strings", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const pastDate = new Date("2026-01-01T00:00:00.000Z");

      const rows = [
        { id: TOKEN_ID_1, familyId: FAMILY_ID_1, createdAt: pastDate, expiresAt: futureDate },
      ];
      const limitMock = jest.fn().mockResolvedValue(rows);
      const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth")
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.body.data[0].createdAt).toBe(pastDate.toISOString());
      expect(res.body.data[0].expiresAt).toBe(futureDate.toISOString());
    });

    it("deduplicates by familyId keeping the latest per family", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const older = new Date("2026-01-01T00:00:00.000Z");
      const newer = new Date("2026-06-01T00:00:00.000Z");

      const rows = [
        { id: TOKEN_ID_1, familyId: FAMILY_ID_1, createdAt: older, expiresAt: futureDate },
        { id: TOKEN_ID_2, familyId: FAMILY_ID_1, createdAt: newer, expiresAt: futureDate },
      ];
      const limitMock = jest.fn().mockResolvedValue(rows);
      const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth?limit=5")
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(TOKEN_ID_2); // newer token kept
    });
  });

  describe("query param validation", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns 400 for limit = 0", async () => {
      const res = await request(app)
        .get("/api/auth?limit=0")
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for limit > 100", async () => {
      const res = await request(app)
        .get("/api/auth?limit=101")
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("accepts limit = 1", async () => {
      const limitMock = jest.fn().mockResolvedValue([]);
      const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth?limit=1")
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(200);
    });
  });

  describe("error propagation", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns 500 when DB throws unexpectedly", async () => {
      const selectMock = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockRejectedValue(new Error("db connection lost")),
            }),
          }),
        }),
      });
      (db.select as jest.Mock) = selectMock;

      const res = await request(app)
        .get("/api/auth")
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(500);
    });
  });
});
