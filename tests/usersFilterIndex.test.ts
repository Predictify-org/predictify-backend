/**
 * tests/usersFilterIndex.test.ts
 *
 * Focused tests for migration 0025_users_filter_idx and the associated
 * GET /api/users route changes (GrantFox FWC26 campaign).
 *
 * Strategy
 * --------
 * Three test suites in one file:
 *
 *   1. Migration SQL — structural verification that the migration file:
 *        • Creates the correct index with the correct column order and sort direction.
 *        • Is idempotent (IF NOT EXISTS).
 *        • Uses CONCURRENTLY to avoid an ACCESS EXCLUSIVE lock.
 *        • Contains a well-formed rollback (DROP INDEX CONCURRENTLY IF EXISTS).
 *        • Does NOT add a redundant index on stellar_address (already covered
 *          by the UNIQUE constraint).
 *
 *   2. Route: listUsersQuerySchema validation — verifies that the router now
 *      uses the shared `listUsersQuerySchema` from `src/validators/users.ts`
 *      instead of an ad-hoc inline schema:
 *        • Rejects unknown query parameters with 400 validation_error.
 *        • Rejects limit=0, limit=101, non-numeric limit.
 *        • Accepts limit=1 and limit=100.
 *        • Defaults limit to 20 when absent.
 *        • Forwards cursor verbatim to the service.
 *        • Happy path returns { data, nextCursor }.
 *        • ETag is emitted on 200 responses.
 *        • 304 is returned when If-None-Match matches.
 *
 *   3. Route: no duplicate /me handler — the duplicate /me registration that
 *      existed in the original users.ts is absent; exactly one handler fires.
 *
 * Mocking approach
 * ----------------
 * Same pattern as tests/usersList.test.ts:
 *   • `pg` and `drizzle-orm/node-postgres` mocked to prevent socket opens.
 *   • `src/db/client` mocked to prevent pool.on() errors.
 *   • Heavy middleware mocked to no-ops.
 *   • `src/services/userService` mocked so tests control output.
 *
 * Coverage targets (≥ 90 % on changed lines in src/routes/users.ts)
 * ------------------------------------------------------------------
 *   ✓ Unknown query key rejected (strict schema)
 *   ✓ limit=0 → 400 validation_error
 *   ✓ limit=101 → 400 validation_error
 *   ✓ non-numeric limit → 400 validation_error
 *   ✓ limit=1 → 200 OK
 *   ✓ limit=100 → 200 OK
 *   ✓ default limit (20) forwarded to service
 *   ✓ cursor forwarded verbatim
 *   ✓ response shape: { data: UserListRow[], nextCursor }
 *   ✓ ETag header present on 200
 *   ✓ 304 returned when If-None-Match matches current ETag
 *   ✓ duplicate /me handler absent
 *   ✓ service error propagates as 500
 *   ✓ migration creates users_created_at_id_idx with correct spec
 *   ✓ migration uses CONCURRENTLY
 *   ✓ migration uses IF NOT EXISTS (idempotent)
 *   ✓ rollback instruction present
 *   ✓ no redundant stellar_address index
 */

// ---------------------------------------------------------------------------
// 1. Env vars — set before any project import.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "users-filter-index-test-secret-at-least-32-bytes!!";
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
// 4. Mock userService so individual tests control service output.
// ---------------------------------------------------------------------------
jest.mock("../src/services/userService", () => ({
  __esModule: true,
  listUsers: jest.fn(),
  getUserByAddress: jest.fn(),
  getUserPredictions: jest.fn(),
  getCurrentUserProfile: jest.fn(),
  getUserProfile: jest.fn(),
}));

// ---------------------------------------------------------------------------
// 5. Project imports — safe after mocks are in place.
// ---------------------------------------------------------------------------
import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { usersRouter } from "../src/routes/users";
import { errorHandler } from "../src/middleware/errorHandler";
import { listUsers, getCurrentUserProfile } from "../src/services/userService";
import { encodeCursor } from "../src/utils/cursor";

const mockListUsers = listUsers as jest.MockedFunction<typeof listUsers>;
const mockGetCurrentUserProfile = getCurrentUserProfile as jest.MockedFunction<
  typeof getCurrentUserProfile
>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Disable Express's built-in weak ETags; our middleware issues strong ones.
  app.set("etag", false);
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ADDR_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ADDR_B = "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO";

// ADDR_B must be exactly 56 chars — pad if fixture is shorter in tests
const USER_A = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  stellarAddress: ADDR_A,
  createdAt: "2026-07-01T12:00:00.000Z",
};
const USER_B = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  stellarAddress: ADDR_B,
  createdAt: "2026-06-30T12:00:00.000Z",
};

const CURSOR_A = encodeCursor({ sortValue: USER_A.createdAt, id: USER_A.id });

// Path to the migration SQL file under test.
const MIGRATION_PATH = path.join(
  __dirname,
  "../drizzle/migrations/0025_users_filter_idx.sql",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const app = makeApp();

function usersUrl(params: Record<string, string | number> = {}): string {
  const qs = Object.keys(params).length
    ? "?" + new URLSearchParams(params as Record<string, string>).toString()
    : "";
  return `/api/users${qs}`;
}

// ---------------------------------------------------------------------------
// ── Suite 1: Migration SQL structural verification ───────────────────────
// ---------------------------------------------------------------------------

describe("Migration 0025_users_filter_idx.sql", () => {
  let sql: string;

  beforeAll(() => {
    // Fail fast if the file doesn't exist — the migration is the primary artifact.
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  });

  it("creates an index named users_created_at_id_idx", () => {
    expect(sql).toMatch(/CREATE INDEX/i);
    expect(sql).toMatch(/users_created_at_id_idx/i);
  });

  it("targets the users table", () => {
    // The ON clause must reference 'users (', not another table.
    expect(sql).toMatch(/ON\s+users\s*\(/i);
  });

  it("indexes created_at DESC as the first (leading) column", () => {
    // Column order is: created_at first, id second — this is what drives the
    // planner to prefer the index for ORDER BY created_at DESC, id DESC.
    const match = sql.match(
      /ON\s+users\s*\(\s*created_at\s+DESC\s*,\s*id\s+DESC\s*\)/i,
    );
    expect(match).not.toBeNull();
  });

  it("uses CONCURRENTLY to avoid an ACCESS EXCLUSIVE lock", () => {
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY/i);
  });

  it("is idempotent via IF NOT EXISTS", () => {
    expect(sql).toMatch(/IF NOT EXISTS/i);
  });

  it("includes a rollback / DROP INDEX instruction", () => {
    // The rollback is documented as a comment so Drizzle doesn't execute it
    // automatically, but it must be present for the runbook.
    expect(sql).toMatch(/DROP INDEX/i);
    expect(sql).toMatch(/users_created_at_id_idx/i);
  });

  it("does not add a redundant index on stellar_address", () => {
    // stellar_address already has an implicit B-tree index via the UNIQUE
    // constraint; a second index would be wasteful write overhead.
    const createIndexLines = sql
      .split("\n")
      .filter(
        (l) =>
          /CREATE INDEX/i.test(l) &&
          !/^--/.test(l.trim()) && // ignore comment lines
          /stellar_address/i.test(l),
      );
    expect(createIndexLines).toHaveLength(0);
  });

  it("migration file name follows the 0025_ prefix convention", () => {
    expect(path.basename(MIGRATION_PATH)).toMatch(/^0025_/);
  });
});

// ---------------------------------------------------------------------------
// ── Suite 2: GET /api/users — schema validation and route behaviour ────────
// ---------------------------------------------------------------------------

describe("GET /api/users (route: users.ts after 0025 changes)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // ── Happy paths ──────────────────────────────────────────────────────────

  describe("happy paths", () => {
    it("returns 200 with data and nextCursor on the first page", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_A, USER_B],
        nextCursor: CURSOR_A,
      });

      const res = await request(app).get(usersUrl());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.nextCursor).toBe(CURSOR_A);
    });

    it("returns nextCursor = null on the last page", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [USER_B], nextCursor: null });

      const res = await request(app).get(usersUrl());

      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
    });

    it("response rows contain id, stellarAddress, and createdAt", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [USER_A], nextCursor: null });

      const res = await request(app).get(usersUrl());

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
        id: USER_A.id,
        stellarAddress: USER_A.stellarAddress,
        createdAt: USER_A.createdAt,
      });
    });

    it("returns empty data array with nextCursor = null when no users exist", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(usersUrl());

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  // ── listUsersQuerySchema validation (strict mode) ────────────────────────

  describe("strict schema validation (listUsersQuerySchema)", () => {
    it("rejects an unknown query key with 400 validation_error", async () => {
      // The route now uses listUsersQuerySchema.strict(), so unknown keys → 400.
      const res = await request(app).get(usersUrl({ foo: "bar" }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(mockListUsers).not.toHaveBeenCalled();
    });

    it("rejects limit=0 with 400 validation_error", async () => {
      const res = await request(app).get(usersUrl({ limit: 0 }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects limit=101 with 400 validation_error", async () => {
      const res = await request(app).get(usersUrl({ limit: 101 }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects non-numeric limit with 400 validation_error", async () => {
      const res = await request(app).get(usersUrl({ limit: "banana" }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("accepts limit=1 (minimum)", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(usersUrl({ limit: 1 }));

      expect(res.status).toBe(200);
      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      );
    });

    it("accepts limit=100 (maximum)", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(usersUrl({ limit: 100 }));

      expect(res.status).toBe(200);
      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it("defaults limit to 20 when ?limit is absent", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      await request(app).get(usersUrl());

      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 }),
      );
    });

    it("response includes requestId in validation error envelope", async () => {
      const res = await request(app).get(usersUrl({ limit: 0 }));

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("requestId");
      expect(typeof res.body.error.requestId).toBe("string");
    });
  });

  // ── Cursor threading ─────────────────────────────────────────────────────

  describe("cursor threading", () => {
    it("forwards cursor string verbatim to listUsers", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [USER_B], nextCursor: null });

      await request(app).get(usersUrl({ cursor: CURSOR_A }));

      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: CURSOR_A }),
      );
    });

    it("threads nextCursor from page 1 into page 2 correctly", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_A],
        nextCursor: CURSOR_A,
      });
      const page1 = await request(app).get(usersUrl({ limit: 1 }));
      const cursor = page1.body.nextCursor as string;

      mockListUsers.mockResolvedValueOnce({
        data: [USER_B],
        nextCursor: null,
      });
      const page2 = await request(app).get(usersUrl({ limit: 1, cursor }));

      expect(page2.status).toBe(200);
      expect(page2.body.data[0].id).toBe(USER_B.id);
      expect(page2.body.nextCursor).toBeNull();
      expect(mockListUsers).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor }),
      );
    });

    it("forwards a garbage cursor to listUsers without 500-ing at the route layer", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [], nextCursor: null });

      const res = await request(app).get(
        usersUrl({ cursor: "!!!INVALID!!!" }),
      );

      expect(res.status).toBe(200);
      expect(mockListUsers).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "!!!INVALID!!!" }),
      );
    });
  });

  // ── ETag / conditional GET ────────────────────────────────────────────────

  describe("ETag / conditional GET", () => {
    it("emits a strong ETag and Cache-Control: no-cache on 200", async () => {
      mockListUsers.mockResolvedValueOnce({
        data: [USER_A],
        nextCursor: null,
      });

      const res = await request(app).get(usersUrl());

      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 304 when If-None-Match matches the current ETag", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [USER_A], nextCursor: null });
      const first = await request(app).get(usersUrl());
      const etag = first.headers["etag"] as string;

      mockListUsers.mockResolvedValueOnce({ data: [USER_A], nextCursor: null });
      const second = await request(app)
        .get(usersUrl())
        .set("If-None-Match", etag);

      expect(second.status).toBe(304);
      expect(second.text).toBe("");
    });

    it("returns 200 when If-None-Match does not match", async () => {
      mockListUsers.mockResolvedValueOnce({ data: [USER_A], nextCursor: null });

      const res = await request(app)
        .get(usersUrl())
        .set("If-None-Match", '"deadbeef"');

      expect(res.status).toBe(200);
    });
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  describe("error propagation", () => {
    it("propagates a service error as HTTP 500", async () => {
      mockListUsers.mockRejectedValueOnce(new Error("DB connection lost"));

      const res = await request(app).get(usersUrl());

      expect(res.status).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// ── Suite 3: GET /api/users/me — no duplicate handler ────────────────────
// ---------------------------------------------------------------------------

describe("GET /api/users/me (duplicate handler regression)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("fires the /me handler exactly once (no duplicate registration)", async () => {
    // If the duplicate handler is still present Express chains both registrations.
    // The mock will be called more than once if both fire.
    mockGetCurrentUserProfile.mockResolvedValueOnce({
      ok: true,
      value: {
        stellarAddress: ADDR_A,
        createdAt: new Date().toISOString(),
        totals: { prediction_count: 0, claim_count: 0 },
      },
    } as any);

    // Build a separate app that injects a fake authenticated user so
    // requireAuthForbidden is satisfied.
    const authApp = express();
    authApp.use(express.json());
    authApp.set("etag", false);
    // Inject req.user before the router handles the request.
    authApp.use((req: any, _res: any, next: any) => {
      req.user = { id: USER_A.id, stellarAddress: ADDR_A };
      next();
    });
    authApp.use("/api/users", usersRouter);
    authApp.use(errorHandler);

    // Call /me — we just care about the status, not the body.
    // If the duplicate handler fired twice, getCurrentUserProfile would be
    // called twice and the second call would throw (no mock registered),
    // causing a 500 instead of the expected 200 / 304.
    const res = await request(authApp).get("/api/users/me");

    // The mock was only set up once — a duplicate handler would exhaust it.
    expect(mockGetCurrentUserProfile).toHaveBeenCalledTimes(1);
    // 200 or 304 — either is fine for this regression check.
    expect([200, 304]).toContain(res.status);
  });
});
