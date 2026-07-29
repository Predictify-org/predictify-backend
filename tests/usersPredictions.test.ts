/**
 * tests/usersPredictions.test.ts
 *
 * Focused unit tests for GET /api/users/:address/predictions
 *
 * Strategy
 * --------
 * Mount `usersRouter` on a minimal Express app (no real DB). Two layers are
 * mocked so the suite can run in CI without a PostgreSQL instance:
 *
 *   1. `pg` / `drizzle-orm/node-postgres` — prevents any socket being opened
 *      during module load (same technique as tests/usersMe.test.ts).
 *   2. `../src/services/userService` — lets individual tests control exactly
 *      what `getUserByAddress` and `getUserPredictions` return.
 *
 * Coverage targets
 * ----------------
 *   - Address validation (400 invalid_address)
 *   - Query-param validation (400 validation_error)
 *   - Unknown user (404 not_found)
 *   - Happy-path: first page with nextCursor
 *   - Happy-path: last page with nextCursor = null
 *   - Cursor threading: nextCursor from page N forwarded into page N+1
 *   - Status filter forwarded to service
 *   - Tampered / malformed cursor handled gracefully (no 500)
 *   - Service error propagates as 500
 */

// ---------------------------------------------------------------------------
// 1. Env vars — must be set before ANY project import.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "users-predictions-test-secret-at-least-32-bytes!!";
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
// 3. Mock drizzle-orm/node-postgres — prevents DB calls leaking out.
// ---------------------------------------------------------------------------
jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({
    select: jest.fn(),
    query: { users: { findFirst: jest.fn() } },
  })),
}));

// ---------------------------------------------------------------------------
// 3a. Mock src/db/client so pool.on() does not throw during module init.
// ---------------------------------------------------------------------------
jest.mock("../src/db/client", () => ({
  db: {
    select: jest.fn(),
    query: { users: { findFirst: jest.fn() } },
  },
  pool: { on: jest.fn(), end: jest.fn() },
}));

// ---------------------------------------------------------------------------
// 4. Mock userService so tests control DB-layer results.
// ---------------------------------------------------------------------------
jest.mock("../src/services/userService", () => ({
  __esModule: true,
  getUserByAddress: jest.fn(),
  getUserPredictions: jest.fn(),
  // keep unused exports to avoid import errors from the router
  getCurrentUserProfile: jest.fn(),
  getUserProfile: jest.fn(),
}));

// ---------------------------------------------------------------------------
// 5. Project imports — safe after mocks are in place.
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import { usersRouter } from "../src/routes/users";
import { errorHandler } from "../src/middleware/errorHandler";
import { getUserByAddress, getUserPredictions } from "../src/services/userService";
import { encodeCursor } from "../src/utils/cursor";

const mockGetUserByAddress = getUserByAddress as jest.MockedFunction<typeof getUserByAddress>;
const mockGetUserPredictions = getUserPredictions as jest.MockedFunction<typeof getUserPredictions>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
// A syntactically valid 56-char Stellar G-address (only A-Z and 2-7 after the leading G).
const VALID_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PREDICTION_ID_1 = "11111111-1111-1111-1111-111111111111";
const PREDICTION_ID_2 = "22222222-2222-2222-2222-222222222222";
const SORT_TS = "2026-06-27T12:00:00.000Z";

const mockUser = {
  id: TEST_USER_ID,
  stellarAddress: VALID_ADDRESS,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

function makePredictionRow(id: string, createdAt = SORT_TS) {
  return {
    id,
    marketId: "market-1",
    question: "Will ETH reach $10k?",
    outcome: "yes",
    amount: "100",
    status: "pending",
    createdAt,
    resolutionTime: "2027-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const app = makeApp();

function predictionsUrl(address: string, params: Record<string, string> = {}) {
  const qs = Object.keys(params).length
    ? "?" + new URLSearchParams(params as Record<string, string>).toString()
    : "";
  return `/api/users/${address}/predictions${qs}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/users/:address/predictions", () => {
  beforeEach(() => {
    // resetAllMocks clears both call history AND the mockOnce queues so
    // unconsumed mockResolvedValueOnce values from one test do not bleed
    // into the next.
    jest.resetAllMocks();
  });

  // ── Address validation ────────────────────────────────────────────────────

  describe("address validation", () => {
    it("returns 400 invalid_address for a non-Stellar string", async () => {
      const res = await request(app).get(predictionsUrl("not-an-address"));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_address");
      // Service must NOT be called
      expect(mockGetUserByAddress).not.toHaveBeenCalled();
    });

    it("returns 400 invalid_address for a too-short address", async () => {
      const res = await request(app).get(predictionsUrl("GSHORT"));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_address");
    });

    it("returns 400 invalid_address when the address starts with the wrong letter", async () => {
      // Must start with 'G' — use a valid-length but wrong-prefix string
      const bad = "A" + VALID_ADDRESS.slice(1);
      const res = await request(app).get(predictionsUrl(bad));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_address");
    });

    it("accepts a valid 56-char G-address", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });
      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(200);
    });
  });

  // ── Query param validation ────────────────────────────────────────────────

  describe("query param validation", () => {
    // Note: query-param validation happens before the DB lookup, so these
    // tests do NOT need a getUserByAddress mock setup.
    it("returns 400 validation_error for an unknown status value", async () => {
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { status: "unknown_status" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockGetUserPredictions).not.toHaveBeenCalled();
    });

    it("returns 400 validation_error for a non-integer limit", async () => {
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { limit: "abc" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error for limit > 100", async () => {
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { limit: "101" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error for limit = 0", async () => {
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { limit: "0" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("accepts limit = 1", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { limit: "1" }),
      );
      expect(res.status).toBe(200);
    });

    it("accepts limit = 100", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { limit: "100" }),
      );
      expect(res.status).toBe(200);
    });

    it("returns 400 validation_error for an unknown query key (strict schema)", async () => {
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { status: "pending", evil: "drop" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockGetUserPredictions).not.toHaveBeenCalled();
    });

    it("returns 400 for a cursor that is only whitespace", async () => {
      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { cursor: "   " }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockGetUserPredictions).not.toHaveBeenCalled();
    });
  });

  // ── User lookup ───────────────────────────────────────────────────────────

  describe("user lookup", () => {
    it("returns 404 not_found when the address is not in the DB", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(undefined);
      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(mockGetUserPredictions).not.toHaveBeenCalled();
    });

    it("forwards the resolved userId to getUserPredictions", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });
      await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(mockGetUserPredictions).toHaveBeenCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ limit: 20 }),
      );
    });
  });

  // ── Happy path — first page ───────────────────────────────────────────────

  describe("happy path — first page", () => {
    it("returns 200 with data array and nextCursor when there is a next page", async () => {
      const cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_1 });
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_1)],
        nextCursor: cursor,
      });

      const res = await request(app).get(predictionsUrl(VALID_ADDRESS, { limit: "1" }));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.nextCursor).toBe(cursor);
    });

    it("returns nextCursor = null on the last page", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_1), makePredictionRow(PREDICTION_ID_2)],
        nextCursor: null,
      });

      const res = await request(app).get(predictionsUrl(VALID_ADDRESS, { limit: "10" }));
      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
    });

    it("returns an empty data array with nextCursor = null when the user has no predictions", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });

    it("defaults limit to 20 when the query param is absent", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(mockGetUserPredictions).toHaveBeenCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ limit: 20 }),
      );
    });
  });

  // ── Cursor threading ──────────────────────────────────────────────────────

  describe("cursor threading", () => {
    it("forwards a valid cursor from page 1 to getUserPredictions on page 2", async () => {
      // Page 1
      const page1Cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_1 });
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_1)],
        nextCursor: page1Cursor,
      });

      const page1 = await request(app).get(predictionsUrl(VALID_ADDRESS, { limit: "1" }));
      expect(page1.status).toBe(200);
      expect(page1.body.nextCursor).toBe(page1Cursor);

      // Page 2 — forward the cursor verbatim
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_2)],
        nextCursor: null,
      });

      const page2 = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { limit: "1", cursor: page1Cursor }),
      );
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      // The cursor must arrive at the service unchanged.
      expect(mockGetUserPredictions).toHaveBeenLastCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ cursor: page1Cursor }),
      );
    });

    it("a tampered / malformed cursor does not cause a 500", async () => {
      // The service receives the tampered string and decodeCursor silently
      // returns null → restarts from page one.
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { cursor: "!!!not-valid-base64url!!!" }),
      );
      // Route should succeed — service handles the bad cursor gracefully.
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("a cursor minted under a legacy version is passed through and handled by the service", async () => {
      // Simulate an old v0 cursor that decodeCursor will reject.
      const legacyCursor = Buffer.from(`v0|${SORT_TS}|${PREDICTION_ID_1}`, "utf8").toString(
        "base64url",
      );
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(
        predictionsUrl(VALID_ADDRESS, { cursor: legacyCursor }),
      );
      expect(res.status).toBe(200);
      // The cursor is forwarded to the service; decodeCursor in the service
      // rejects it and restarts from page one — no 500.
      expect(mockGetUserPredictions).toHaveBeenCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ cursor: legacyCursor }),
      );
    });
  });

  // ── Status filter ─────────────────────────────────────────────────────────

  describe("status filter", () => {
    it.each([
      ["pending"],
      ["confirmed"],
      ["won"],
      ["lost"],
      ["claimed"],
    ] as const)("forwards status=%s to getUserPredictions", async (status) => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(predictionsUrl(VALID_ADDRESS, { status }));
      expect(res.status).toBe(200);
      expect(mockGetUserPredictions).toHaveBeenCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ status }),
      );
    });

    it("omits the status field when the param is absent", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(mockGetUserPredictions).toHaveBeenCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ status: undefined }),
      );
    });
  });

  // ── Response shape ────────────────────────────────────────────────────────

  describe("response shape", () => {
    it("response always includes both data and nextCursor fields", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("nextCursor");
    });

    it("serialises the prediction rows returned by the service verbatim", async () => {
      const row = makePredictionRow(PREDICTION_ID_1);
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockResolvedValueOnce({ data: [row], nextCursor: null });

      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
        id: PREDICTION_ID_1,
        outcome: "yes",
        amount: "100",
        status: "pending",
      });
    });
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  describe("error propagation", () => {
    it("returns 500 when getUserByAddress throws unexpectedly", async () => {
      mockGetUserByAddress.mockRejectedValueOnce(new Error("db failure"));
      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(500);
    });

    it("returns 500 when getUserPredictions throws unexpectedly", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(mockUser);
      mockGetUserPredictions.mockRejectedValueOnce(new Error("query timeout"));
      const res = await request(app).get(predictionsUrl(VALID_ADDRESS));
      expect(res.status).toBe(500);
    });
  });
});
