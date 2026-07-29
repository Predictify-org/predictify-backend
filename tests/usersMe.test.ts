/**
 * Tests for GET /api/users/me
 *
 * Strategy
 * --------
 * Mount `usersRouter` directly on a small Express app (same pattern as
 * `tests/adminUsers.test.ts`) so this suite does not depend on `src/index.ts`
 * and can run cleanly even when other parts of the project are WIP.
 *
 * The intermediate layers are mocked:
 *   1. `pg` and `drizzle-orm/node-postgres` — so `requireAuthForbidden`'s
 *      DB-backed user lookup can be controlled with a row fixture.
 *   2. `src/services/userService` — so the aggregate COUNTs are stubbed
 *      and we exercise only the route + middleware wiring here.  Unit
 *      tests for the service live alongside it.
 *
 * Environment
 * -----------
 * JWT_SECRET, JWT_ISSUER, and JWT_AUDIENCE must be set BEFORE the project
 * modules are imported (env.ts validates at import time).
 */

// ---------------------------------------------------------------------------
// 1. Env vars (must run BEFORE project imports)
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "users-me-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mock `pg` so requireAuthForbidden cannot open a real socket.
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
// 3. Mock drizzle-orm/node-postgres so the user lookup chain is controllable.
//    The chain shape used by `requireAuthForbidden`: `select → from → where → limit`.
// ---------------------------------------------------------------------------
const authLimit = jest.fn();
const authWhere = jest.fn(() => ({ limit: authLimit }));
const authFrom = jest.fn(() => ({ where: authWhere }));
const authSelect = jest.fn(() => ({ from: authFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: authSelect })),
}));

// ---------------------------------------------------------------------------
// 3a. Mock src/db/client directly so pool.on() does not throw on module init.
// ---------------------------------------------------------------------------
jest.mock("../src/db/client", () => ({
  db: { select: jest.fn() },
  pool: { on: jest.fn(), end: jest.fn() },
}));

// ---------------------------------------------------------------------------
// 4. Mock the userService so we control the aggregated profile.
// ---------------------------------------------------------------------------
jest.mock("../src/services/userService", () => {
  const actual = jest.requireActual("../src/services/userService");
  return {
    __esModule: true,
    ...actual,
    getCurrentUserProfile: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// 5. Project imports (safe now — env is set, mocks are in place).
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { usersRouter } from "../src/routes/users";
import { errorHandler } from "../src/middleware/errorHandler";
import { getCurrentUserProfile } from "../src/services/userService";

const mockGetCurrentUserProfile =
  getCurrentUserProfile as jest.MockedFunction<typeof getCurrentUserProfile>;

// ---------------------------------------------------------------------------
// App factory — mirrors adminUsers.test.ts pattern.
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEST_SECRET = process.env.JWT_SECRET!;
const TEST_ISSUER = process.env.JWT_ISSUER!;
const TEST_AUDIENCE = process.env.JWT_AUDIENCE!;
const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_STELLAR = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";
const TEST_CREATED_AT = "2024-06-15T12:00:00.000Z";

function signToken(sub: string = TEST_STELLAR, options: jwt.SignOptions = {}): string {
  return jwt.sign({ sub }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
    ...options,
  });
}

function mockDbReturnsUser(): void {
  authLimit.mockResolvedValueOnce([
    { id: TEST_USER_ID, stellarAddress: TEST_STELLAR },
  ]);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("GET /api/users/me", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-chain the drizzle mock after clearAllMocks wipes implementations.
    authSelect.mockImplementation(() => ({ from: authFrom } as any));
    authFrom.mockImplementation(() => ({ where: authWhere } as any));
    authWhere.mockImplementation(() => ({ limit: authLimit } as any));
  });

  // ── 403 / auth ────────────────────────────────────────────────────────────

  it("returns 403 with code=forbidden when Authorization header is absent", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 when the Authorization header uses a non-Bearer scheme", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Token ${signToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 403 for an expired token", async () => {
    const expired = signToken(TEST_STELLAR, { expiresIn: -1 });
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 403 for a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { sub: TEST_STELLAR },
      "wrong-but-long-enough-secret-value-32-bytes!",
      {
        algorithm: "HS256",
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        expiresIn: 3600,
      },
    );
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 403 when the JWT is valid but the user does not exist", async () => {
    authLimit.mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it("returns 200 with stellarAddress, createdAt, and totals on success", async () => {
    mockDbReturnsUser();
    mockGetCurrentUserProfile.mockResolvedValueOnce({
      ok: true as const,
      value: {
        stellarAddress: TEST_STELLAR,
        createdAt: TEST_CREATED_AT,
        totals: { prediction_count: 7, claim_count: 2 },
      },
    });

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        stellarAddress: TEST_STELLAR,
        createdAt: TEST_CREATED_AT,
        totals: { prediction_count: 7, claim_count: 2 },
      },
    });
  });

  it("passes req.user.id (UUID) — NOT the stellar address — to the service", async () => {
    mockDbReturnsUser();
    mockGetCurrentUserProfile.mockResolvedValueOnce({
      ok: true as const,
      value: {
        stellarAddress: TEST_STELLAR,
        createdAt: TEST_CREATED_AT,
        totals: { prediction_count: 0, claim_count: 0 },
      },
    });

    await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(mockGetCurrentUserProfile).toHaveBeenCalledTimes(1);
    // The aggregate COUNT queries hit FKs on user_id, so the argument MUST
    // be the UUID, not the Stellar address.
    expect(mockGetCurrentUserProfile).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("returns 500 when the user row vanished mid-request (defensive branch)", async () => {
    // requireAuthForbidden verified the user exists at JWT time, but the
    // service has a defensive branch in case the row is deleted between
    // then and the COUNT queries — covering that path keeps regressions
    // from silently masking a real bug.
    mockDbReturnsUser();
    mockGetCurrentUserProfile.mockRejectedValueOnce(new Error("user row vanished mid-request"));

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
  });

  it("propagates other service errors to the global error handler (500 internal_error)", async () => {
    mockDbReturnsUser();
    mockGetCurrentUserProfile.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
  });

  // ── Route-ordering correctness ──────────────────────────────────────────

  it("does NOT treat 'me' as a `/:address` path parameter", async () => {
    // If /me were captured by the /:address/predictions route, the response
    // would be 400 invalid_address (from the Stellar address regex) or a
    // 404.  Hitting the /me handler proves Express matched it correctly.
    mockDbReturnsUser();
    mockGetCurrentUserProfile.mockResolvedValueOnce({
      ok: true as const,
      value: {
        stellarAddress: TEST_STELLAR,
        createdAt: TEST_CREATED_AT,
        totals: { prediction_count: 0, claim_count: 0 },
      },
    });

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stellarAddress).toBe(TEST_STELLAR);
  });
});
