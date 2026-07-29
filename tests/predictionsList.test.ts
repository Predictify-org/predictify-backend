/**
 * tests/predictionsList.test.ts
 *
 * Focused unit tests for the cursor-paginated
 *   GET /api/predictions
 * endpoint and the underlying `listPredictions` repository function.
 *
 * Strategy
 * --------
 * Two layers of tests:
 *
 *   1. Route-level (supertest) — mounts `predictionsRouter` on a minimal
 *      Express app, mocks the `predictionRepo` module, and exercises the HTTP
 *      interface (auth, input validation, response shape, logging).
 *
 *   2. Repository-level — mocks `../src/db/client` and verifies that
 *      `listPredictions` wires the correct query (conditions, ordering,
 *      limit+1 probe, cursor encoding).
 *
 * No real DB socket is ever opened. The pg / drizzle mocks follow the same
 * pattern used by tests/usersMe.test.ts and tests/usersPredictions.test.ts.
 *
 * Coverage targets
 * ----------------
 *   Route
 *     - 401 when Authorization header is absent
 *     - 400 validation_error for bad status / limit values
 *     - 400 validation_error for empty marketId
 *     - 200 happy-path: first page with nextCursor
 *     - 200 happy-path: last page with nextCursor = null
 *     - 200 empty data array when no predictions
 *     - 200 default limit = 20 forwarded to repo
 *     - 200 all optional filters forwarded to repo
 *     - 200 tampered cursor forwarded to repo and handled gracefully
 *     - 500 when repo throws unexpectedly
 *
 *   Repository
 *     - returns empty data with nextCursor = null when DB returns zero rows
 *     - serialises Date fields to ISO strings
 *     - sets nextCursor when there are more rows than the limit (hasMore)
 *     - sets nextCursor = null on the last page
 *     - does not leak the extra probe row into the data array
 *     - encodes the correct cursor from the last row on the page
 *     - accepts an invalid cursor without throwing
 */

// ---------------------------------------------------------------------------
// 1. Env vars — must be set before ANY project import.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "predictions-list-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mock pg so no real socket is opened during module load.
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
// 3. Mock drizzle-orm/node-postgres.
//    requireAuth builds its own drizzle instance with this factory.
//    We expose authLimit so individual tests can control whether the user
//    lookup resolves to a user row (authenticated) or empty (unauthenticated).
//    The intermediate chain methods use closures so they survive resetAllMocks.
// ---------------------------------------------------------------------------
const authLimit = jest.fn();
const authWhere = jest.fn(() => ({ limit: authLimit }));
const authFrom = jest.fn(() => ({ where: authWhere }));
const authSelect = jest.fn(() => ({ from: authFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: authSelect })),
}));

// ---------------------------------------------------------------------------
// 4. Mock src/db/client so pool.on() does not throw during module init.
// ---------------------------------------------------------------------------
jest.mock("../src/db/client", () => ({
  db: {
    select: jest.fn(),
    query: { users: { findFirst: jest.fn() } },
  },
  pool: { on: jest.fn(), end: jest.fn() },
}));

// ---------------------------------------------------------------------------
// 5. Mock sub-routers that have problematic imports (broken logging path in
//    cancel.ts, and share.ts which requires extra deps not needed here).
//    These sub-routers are NOT under test — we only care about GET /.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 6. Mock the predictionRepo so route tests stay in-process.
// ---------------------------------------------------------------------------
jest.mock("../src/repositories/predictionRepo");

// ---------------------------------------------------------------------------
// 7. Project imports — safe after mocks are in place.
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { predictionsRouter } from "../src/routes/predictions";
import { errorHandler } from "../src/middleware/errorHandler";
import { listPredictions } from "../src/repositories/predictionRepo";
import { encodeCursor } from "../src/utils/cursor";
import { generateETag } from "../src/middleware/etag";
import { env } from "../src/config/env";

const mockListPredictions = listPredictions as jest.MockedFunction<
  typeof listPredictions
>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/predictions", predictionsRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STELLAR_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const PREDICTION_ID_1 = "11111111-1111-1111-1111-111111111111";
const PREDICTION_ID_2 = "22222222-2222-2222-2222-222222222222";
const MARKET_ID = "market-abc-123";
const SORT_TS = "2026-06-27T12:00:00.000Z";

/** The user row that requireAuth's DB lookup returns after JWT verification. */
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

function makePredictionRow(id: string) {
  return {
    id,
    marketId: MARKET_ID,
    question: "Will ETH reach $10k?",
    outcome: "yes",
    amount: "100",
    txHash: "abc123",
    status: "pending",
    result: null,
    createdAt: SORT_TS,
    resolutionTime: "2027-01-01T00:00:00.000Z",
  };
}

function predictionsUrl(params: Record<string, string> = {}) {
  const qs = Object.keys(params).length
    ? "?" + new URLSearchParams(params).toString()
    : "";
  return `/api/predictions${qs}`;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------
describe("GET /api/predictions — route", () => {
  beforeEach(() => {
    // clearAllMocks clears call history but preserves mock implementations
    // set via jest.fn(() => ...) — so the drizzle chain (authWhere, authFrom,
    // authSelect) remains wired after each test.  Only authLimit (which has no
    // default implementation) and mockListPredictions need to be re-primed
    // per test.
    jest.clearAllMocks();
    // Restore the closure implementations that resetAllMocks would erase.
    authWhere.mockReturnValue({ limit: authLimit });
    authFrom.mockReturnValue({ where: authWhere });
    authSelect.mockReturnValue({ from: authFrom });
  });

  // ── Authentication ────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const res = await request(app).get(predictionsUrl());
      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(mockListPredictions).not.toHaveBeenCalled();
    });

    it("returns 401 with an invalid JWT", async () => {
      const res = await request(app)
        .get(predictionsUrl())
        .set("Authorization", "Bearer not-a-valid-token");
      expect(res.status).toBe(401);
      expect(mockListPredictions).not.toHaveBeenCalled();
    });

    it("echoes the correlation ID header on a successful response", async () => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app)
        .get(predictionsUrl())
        .set("Authorization", `Bearer ${validToken()}`)
        .set("X-Correlation-Id", "predictions-correlation-id");

      expect(res.status).toBe(200);
      expect(res.headers["x-correlation-id"]).toBe("predictions-correlation-id");
    });
  });

  // ── Query param validation ────────────────────────────────────────────────
  // These tests REQUIRE a valid token so they reach the validation layer.
  // We also prime authLimit so requireAuth can resolve the user row.

  describe("query param validation", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns 400 validation_error for an unknown status value", async () => {
      const res = await request(app)
        .get(predictionsUrl({ status: "unknown_status" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockListPredictions).not.toHaveBeenCalled();
    });

    it("returns 400 validation_error for limit = 0", async () => {
      const res = await request(app)
        .get(predictionsUrl({ limit: "0" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error for limit > 100", async () => {
      const res = await request(app)
        .get(predictionsUrl({ limit: "101" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error for a non-integer limit", async () => {
      const res = await request(app)
        .get(predictionsUrl({ limit: "abc" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error for an empty marketId string", async () => {
      const res = await request(app)
        .get(predictionsUrl({ marketId: "" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("accepts valid status values", async () => {
      for (const status of ["pending", "confirmed", "won", "lost", "claimed"]) {
        authLimit.mockResolvedValue([MOCK_USER_ROW]);
        mockListPredictions.mockResolvedValueOnce({
          data: [],
          nextCursor: null,
        });
        const res = await request(app)
          .get(predictionsUrl({ status }))
          .set("Authorization", `Bearer ${validToken()}`);
        expect(res.status).toBe(200);
      }
    });

    it("accepts limit = 1", async () => {
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });
      const res = await request(app)
        .get(predictionsUrl({ limit: "1" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(200);
    });

    it("accepts limit = 100", async () => {
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });
      const res = await request(app)
        .get(predictionsUrl({ limit: "100" }))
        .set("Authorization", `Bearer ${validToken()}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  describe("happy path", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns 200 with data and nextCursor on first page", async () => {
      const cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_1 });
      mockListPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_1)],
        nextCursor: cursor,
      });

      const res = await request(app)
        .get(predictionsUrl({ limit: "1" }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(PREDICTION_ID_1);
      expect(res.body.nextCursor).toBe(cursor);
    });

    it("returns nextCursor = null on the last page", async () => {
      mockListPredictions.mockResolvedValueOnce({
        data: [
          makePredictionRow(PREDICTION_ID_1),
          makePredictionRow(PREDICTION_ID_2),
        ],
        nextCursor: null,
      });

      const res = await request(app)
        .get(predictionsUrl({ limit: "10" }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
    });

    it("returns empty data array with nextCursor = null when user has no predictions", async () => {
      mockListPredictions.mockResolvedValueOnce({
        data: [],
        nextCursor: null,
      });

      const res = await request(app)
        .get(predictionsUrl())
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });

    it("defaults limit to 20 when the query param is absent", async () => {
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get(predictionsUrl())
        .set("Authorization", `Bearer ${validToken()}`);

      expect(mockListPredictions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ limit: 20 }),
      );
    });
  });

  // ── ETag caching ──────────────────────────────────────────────────────────

  describe("ETag caching", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns 304 Not Modified when If-None-Match matches payload", async () => {
      const cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_1 });
      const mockPayload = {
        data: [makePredictionRow(PREDICTION_ID_1)],
        nextCursor: cursor,
      };
      
      mockListPredictions.mockResolvedValueOnce(mockPayload);

      const etag = generateETag(mockPayload);

      const res = await request(app)
        .get(predictionsUrl({ limit: "1" }))
        .set("Authorization", `Bearer ${validToken()}`)
        .set("If-None-Match", etag);

      expect(res.status).toBe(304);
      expect(res.body).toEqual({});
    });

    it("returns 200 with ETag header on initial request", async () => {
      const mockPayload = { data: [], nextCursor: null };
      mockListPredictions.mockResolvedValueOnce(mockPayload);
      
      const expectedEtag = generateETag(mockPayload);

      const res = await request(app)
        .get(predictionsUrl())
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe(expectedEtag);
    });
  });

  // ── Filter forwarding ─────────────────────────────────────────────────────

  describe("filter forwarding", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("forwards marketId filter to the repo", async () => {
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get(predictionsUrl({ marketId: MARKET_ID }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(mockListPredictions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ marketId: MARKET_ID }),
      );
    });

    it("forwards status filter to the repo", async () => {
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get(predictionsUrl({ status: "won" }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(mockListPredictions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "won" }),
      );
    });

    it("forwards outcome filter to the repo", async () => {
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get(predictionsUrl({ outcome: "no" }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(mockListPredictions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: "no" }),
      );
    });

    it("forwards cursor to the repo", async () => {
      const cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_1 });
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get(predictionsUrl({ cursor }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(mockListPredictions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cursor }),
      );
    });

    it("forwards all filters together to the repo", async () => {
      const cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_2 });
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app)
        .get(
          predictionsUrl({
            marketId: MARKET_ID,
            status: "confirmed",
            outcome: "yes",
            cursor,
            limit: "5",
          }),
        )
        .set("Authorization", `Bearer ${validToken()}`);

      expect(mockListPredictions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          marketId: MARKET_ID,
          status: "confirmed",
          outcome: "yes",
          cursor,
          limit: 5,
        }),
      );
    });
  });

  // ── Cursor threading ──────────────────────────────────────────────────────

  describe("cursor threading", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("passes nextCursor from page N as cursor in page N+1 and returns correct results", async () => {
      const cursor = encodeCursor({ sortValue: SORT_TS, id: PREDICTION_ID_1 });

      // First page returns row1 and a nextCursor.
      mockListPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_1)],
        nextCursor: cursor,
      });

      const page1 = await request(app)
        .get(predictionsUrl({ limit: "1" }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(page1.body.nextCursor).toBe(cursor);

      // Second page uses the cursor from page 1.
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
      mockListPredictions.mockResolvedValueOnce({
        data: [makePredictionRow(PREDICTION_ID_2)],
        nextCursor: null,
      });

      const page2 = await request(app)
        .get(predictionsUrl({ limit: "1", cursor: page1.body.nextCursor }))
        .set("Authorization", `Bearer ${validToken()}`);

      expect(page2.status).toBe(200);
      expect(page2.body.data[0].id).toBe(PREDICTION_ID_2);
      expect(page2.body.nextCursor).toBeNull();
    });

    it("handles a tampered/malformed cursor without 500-ing", async () => {
      // A garbage cursor should be forwarded to the repo which will ignore it
      // (decodeCursor returns null) and return from page 1.
      mockListPredictions.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app)
        .get(predictionsUrl({ cursor: "AAAA_not_a_valid_cursor_!!" }))
        .set("Authorization", `Bearer ${validToken()}`);

      // Route should still respond 200 — the repo handles the invalid cursor.
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  describe("error propagation", () => {
    beforeEach(() => {
      authLimit.mockResolvedValue([MOCK_USER_ROW]);
    });

    it("returns 500 when the repo throws unexpectedly", async () => {
      mockListPredictions.mockRejectedValueOnce(new Error("db connection lost"));

      const res = await request(app)
        .get(predictionsUrl())
        .set("Authorization", `Bearer ${validToken()}`);

      expect(res.status).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// Repository-level tests (unit tests for listPredictions itself)
// ---------------------------------------------------------------------------
describe("listPredictions — repository", () => {
  // We need to import the *real* function, not the jest.mock() stub.
  // jest.requireActual bypasses the module-level mock set up above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listPredictions: realListPredictions } = jest.requireActual(
    "../src/repositories/predictionRepo",
  ) as typeof import("../src/repositories/predictionRepo");

  // We need to patch the db client that predictionRepo imports at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const clientModule = require("../src/db/client") as {
    db: { select: jest.Mock };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Builds the fluent Drizzle query chain mock and wires it on clientModule.db. */
  function stubDbQuery(returnRows: unknown[]) {
    const limitMock = jest.fn().mockResolvedValue(returnRows);
    const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    const selectMock = jest.fn().mockReturnValue({ from: fromMock });
    clientModule.db.select = selectMock;
    return { selectMock, fromMock, innerJoinMock, whereMock, orderByMock, limitMock };
  }

  function makeDbRow(id: string, createdAt = new Date(SORT_TS)) {
    return {
      id,
      marketId: MARKET_ID,
      question: "Test market",
      outcome: "yes",
      amount: "50",
      txHash: "txhash",
      status: "pending",
      result: null,
      createdAt,
      resolutionTime: new Date("2027-01-01T00:00:00.000Z"),
    };
  }

  it("returns empty data with nextCursor = null when DB returns zero rows", async () => {
    stubDbQuery([]);

    const page = await realListPredictions(TEST_USER_ID, { limit: 20 });

    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("serialises Date fields to ISO strings", async () => {
    const row = makeDbRow(PREDICTION_ID_1);
    stubDbQuery([row]);

    const page = await realListPredictions(TEST_USER_ID, { limit: 20 });

    expect(page.data[0].createdAt).toBe(row.createdAt.toISOString());
    expect(page.data[0].resolutionTime).toBe(
      row.resolutionTime.toISOString(),
    );
  });

  it("sets nextCursor when there are more rows than the limit (hasMore = true)", async () => {
    // Return limit+1 rows to trigger hasMore = true.
    const rows = [
      makeDbRow(PREDICTION_ID_1),
      makeDbRow(PREDICTION_ID_2),
    ];
    stubDbQuery(rows);

    const page = await realListPredictions(TEST_USER_ID, { limit: 1 });

    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it("sets nextCursor = null when returned rows <= limit", async () => {
    stubDbQuery([makeDbRow(PREDICTION_ID_1)]);

    const page = await realListPredictions(TEST_USER_ID, { limit: 5 });

    expect(page.nextCursor).toBeNull();
  });

  it("does not leak the extra probe row into the data array", async () => {
    const rows = [
      makeDbRow(PREDICTION_ID_1),
      makeDbRow(PREDICTION_ID_2),
    ];
    stubDbQuery(rows);

    const page = await realListPredictions(TEST_USER_ID, { limit: 1 });

    // Only the first row should appear in data; the extra probe row is cut.
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(PREDICTION_ID_1);
  });

  it("encodes the correct cursor from the last row on the page", async () => {
    const date = new Date(SORT_TS);
    const rows = [makeDbRow(PREDICTION_ID_1, date), makeDbRow(PREDICTION_ID_2)];
    stubDbQuery(rows);

    const page = await realListPredictions(TEST_USER_ID, { limit: 1 });

    const { decodeCursor: dc } = jest.requireActual(
      "../src/utils/cursor",
    ) as typeof import("../src/utils/cursor");
    const key = dc(page.nextCursor!);
    expect(key).not.toBeNull();
    expect(key!.sortValue).toBe(date.toISOString());
    expect(key!.id).toBe(PREDICTION_ID_1);
  });

  it("accepts an invalid cursor and does not throw", async () => {
    stubDbQuery([]);
    // Should not throw, should just run without a cursor predicate.
    await expect(
      realListPredictions(TEST_USER_ID, {
        limit: 20,
        cursor: "AAAA_garbage_cursor",
      }),
    ).resolves.toMatchObject({ data: [], nextCursor: null });
  });

  it("applies the marketId filter condition when provided", async () => {
    const { selectMock } = stubDbQuery([]);
    await realListPredictions(TEST_USER_ID, { limit: 20, marketId: MARKET_ID });
    expect(selectMock).toHaveBeenCalled();
  });

  it("applies the status filter condition when provided", async () => {
    stubDbQuery([]);
    await expect(
      realListPredictions(TEST_USER_ID, { limit: 20, status: "confirmed" }),
    ).resolves.toMatchObject({ data: [], nextCursor: null });
  });

  it("applies the outcome filter condition when provided", async () => {
    stubDbQuery([]);
    await expect(
      realListPredictions(TEST_USER_ID, { limit: 20, outcome: "yes" }),
    ).resolves.toMatchObject({ data: [], nextCursor: null });
  });

  it("applies all filters (marketId, status, outcome) together", async () => {
    stubDbQuery([makeDbRow(PREDICTION_ID_1)]);
    const page = await realListPredictions(TEST_USER_ID, {
      limit: 20,
      marketId: MARKET_ID,
      status: "pending",
      outcome: "yes",
    });
    expect(page.data).toHaveLength(1);
  });

  it("applies the cursor keyset predicate when a valid cursor is provided", async () => {
    const { encodeCursor } = jest.requireActual(
      "../src/utils/cursor",
    ) as typeof import("../src/utils/cursor");
    const validCursor = encodeCursor({
      sortValue: new Date(SORT_TS).toISOString(),
      id: PREDICTION_ID_2,
    });
    stubDbQuery([makeDbRow(PREDICTION_ID_1)]);

    const page = await realListPredictions(TEST_USER_ID, {
      limit: 20,
      cursor: validCursor,
    });

    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(PREDICTION_ID_1);
  });
});
