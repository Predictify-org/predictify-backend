/**
 * tests/usersList.test.ts
 *
 * Focused unit tests for GET /api/users (cursor-paginated user listing).
 *
 * Strategy
 * --------
 * Mount `usersRouter` on a minimal Express app.  Two layers are mocked so the
 * suite runs in CI without a live PostgreSQL instance:
 *
 *   1. `pg` / `drizzle-orm/node-postgres` — prevents socket opens at module load.
 *   2. `../src/services/userService`       — lets tests control listUsers output.
 *
 * Coverage targets
 * ----------------
 *   - Happy path: first page with nextCursor present
 *   - Happy path: last page with nextCursor = null
 *   - Cursor threading: nextCursor from page N passed into page N+1
 *   - Default limit (20) is used when ?limit is absent
 *   - Custom valid limit is forwarded to the service
 *   - limit=0 rejected with 400 validation_error
 *   - limit=101 rejected with 400 validation_error
 *   - Non-numeric limit rejected with 400 validation_error
 *   - Tampered / garbage cursor forwarded to service (no 500 at route layer)
 *   - Service error propagates as 500
 *   - Response shape: { data: UserListRow[], nextCursor: string | null }
 *   - Each UserListRow contains id, stellarAddress, createdAt
 */

// ---------------------------------------------------------------------------
// 1. Env vars — set before any project import.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "users-list-test-secret-at-least-32-bytes!!!!";
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
// 3b. Middleware that would otherwise pull in heavy deps — no-op in tests.
// ---------------------------------------------------------------------------
jest.mock("../src/middleware/rateLimit", () => ({
  createPerUserRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/middleware/timeout", () => ({
  requestTimeout: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/metrics/usersMetrics", () => ({
  usersMetricsMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/middleware/accessLog", () => ({
  accessLog: (_req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// 4. Mock userService so individual tests control listUsers output.
// ---------------------------------------------------------------------------
jest.mock("../src/services/userService", () => ({
  __esModule: true,
  listUsers: jest.fn(),
  // Keep all other exports to avoid import errors from the router.
  getUserByAddress: jest.fn(),
  getUserPredictions: jest.fn(),
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
import { listUsers } from "../src/services/userService";
import { encodeCursor } from "../src/utils/cursor";

const mockListUsers = listUsers as jest.MockedFunction<typeof listUsers>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.set("etag", false);
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const USER_1 = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  stellarAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
  createdAt: "2026-06-27T12:00:00.000Z",
};
const USER_2 = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  stellarAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  createdAt: "2026-06-26T12:00:00.000Z",
};

const CURSOR_FOR_USER_1 = encodeCursor({
  sortValue: USER_1.createdAt,
  id: USER_1.id,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const app = makeApp();

function usersListUrl(params: Record<string, string | number> = {}): string {
  const qs = Object.keys(params).length
    ? "?" + new URLSearchParams(params as Record<string, string>).toString()
    : "";
  return `/api/users${qs}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/users", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // ── Happy paths ────────────────────────────────────────────────────────────

  describe("happy paths", () => {
    it("returns 200 with data and nextCursor on the first page", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_1, USER_2],
        nextCursor: CURSOR_FOR_USER_1,
      });

      const res = await request(app).get(usersListUrl());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.nextCursor).toBe(CURSOR_FOR_USER_1);
    });

    it("returns nextCursor = null on the last page", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_2],
        nextCursor: null,
      });

      const res = await request(app).get(usersListUrl());

      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
    });

    it("response data rows have id, stellarAddress, and createdAt", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_1],
        nextCursor: null,
      });

      const res = await request(app).get(usersListUrl());

      expect(res.status).toBe(200);
      const row = res.body.data[0];
      expect(row).toMatchObject({
        id: USER_1.id,
        stellarAddress: USER_1.stellarAddress,
        createdAt: USER_1.createdAt,
      });
    });

    it("returns an empty data array with nextCursor = null when there are no users", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(usersListUrl());

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  // ── Limit forwarding ───────────────────────────────────────────────────────

  describe("limit handling", () => {
    it("forwards limit=5 to listUsers", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app).get(usersListUrl({ limit: 5 }));

      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 }),
      );
    });

    it("defaults to limit=20 when ?limit is absent", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app).get(usersListUrl());

      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 }),
      );
    });

    it("accepts limit=100 (maximum)", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(usersListUrl({ limit: 100 }));

      expect(res.status).toBe(200);
      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it("rejects limit=0 with 400 validation_error", async () => {
      const res = await request(app).get(usersListUrl({ limit: 0 }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockListUsers).not.toHaveBeenCalled();
    });

    it("rejects limit=101 with 400 validation_error", async () => {
      const res = await request(app).get(usersListUrl({ limit: 101 }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockListUsers).not.toHaveBeenCalled();
    });

    it("rejects non-numeric limit with 400 validation_error", async () => {
      const res = await request(app).get(usersListUrl({ limit: "banana" }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockListUsers).not.toHaveBeenCalled();
    });
  });

  // ── Cursor threading ───────────────────────────────────────────────────────

  describe("cursor threading", () => {
    it("forwards cursor string to listUsers", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [USER_2], nextCursor: null });

      await request(app).get(usersListUrl({ cursor: CURSOR_FOR_USER_1 }));

      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: CURSOR_FOR_USER_1 }),
      );
    });

    it("threads nextCursor from page 1 into page 2 correctly", async () => {
      // Page 1 — service returns USER_1 with a nextCursor
      mockListUsers.mockResolvedValueOnce({
        data: [USER_1],
        nextCursor: CURSOR_FOR_USER_1,
      });
      const page1 = await request(app).get(usersListUrl({ limit: 1 }));
      expect(page1.status).toBe(200);
      const cursor = page1.body.nextCursor as string;
      expect(cursor).toBe(CURSOR_FOR_USER_1);

      // Page 2 — pass cursor back; service returns USER_2, no further pages
      mockListUsers.mockResolvedValueOnce({
        data: [USER_2],
        nextCursor: null,
      });
      const page2 = await request(app).get(usersListUrl({ limit: 1, cursor }));
      expect(page2.status).toBe(200);
      expect(page2.body.data[0].id).toBe(USER_2.id);
      expect(page2.body.nextCursor).toBeNull();

      // Verify the cursor was forwarded verbatim
      expect(mockListUsers).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor }),
      );
    });

    it("forwards a tampered cursor to listUsers without 500-ing at the route layer", async () => {
      // The route does not validate the cursor; listUsers (or decodeCursor) handles it.
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(
        usersListUrl({ cursor: "!!!INVALID!!!" }),
      );

      expect(res.status).toBe(200);
      // Service was called — it decides how to handle the bad cursor.
      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "!!!INVALID!!!" }),
      );
    });
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  describe("error propagation", () => {
    it("propagates a service error as HTTP 500", async () => {
      mockListUsers.mockRejectedValueOnce(new Error("DB exploded"));

      const res = await request(app).get(usersListUrl());

      expect(res.status).toBe(500);
    });
  });

  // ── ETag / conditional GET ─────────────────────────────────────────────────

  describe("ETag / conditional GET", () => {
    it("returns strong ETag and Cache-Control: no-cache on 200", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_1],
        nextCursor: null,
      });

      const res = await request(app).get(usersListUrl());

      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 304 when If-None-Match matches", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_1],
        nextCursor: null,
      });
      const first = await request(app).get(usersListUrl());
      const etag = first.headers["etag"] as string;

      mockListUsers.mockResolvedValueOnce({
        data: [USER_1],
        nextCursor: null,
      });
      const second = await request(app)
        .get(usersListUrl())
        .set("If-None-Match", etag);

      expect(second.status).toBe(304);
      expect(second.text).toBe("");
    });
  });
});
