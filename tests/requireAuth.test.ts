/**
 * Tests for requireAuth and optionalAuth middleware.
 *
 * Strategy
 * --------
 * The middleware depends on:
 *   1. `jsonwebtoken`  — for JWT verification (real library, no mock needed)
 *   2. `drizzle-orm`   — for the DB query
 *   3. `pg`            — for the underlying connection pool
 *
 * We mock the `pg` Pool and the drizzle select chain so the tests run
 * without a real database while exercising the full middleware logic.
 *
 * Environment
 * -----------
 * JWT_SECRET, JWT_ISSUER, and JWT_AUDIENCE are set in beforeAll so that
 * `env.ts` (which validates at import time) gets valid values.
 */

// ---------------------------------------------------------------------------
// 1. Provide env vars BEFORE any project module is imported.
// ---------------------------------------------------------------------------
const TEST_SECRET = "a-very-long-test-secret-at-least-32-bytes!!";
const TEST_ISSUER = "predictify";
const TEST_AUDIENCE = "predictify-app";
const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_STELLAR = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = TEST_SECRET;
process.env.JWT_ISSUER = TEST_ISSUER;
process.env.JWT_AUDIENCE = TEST_AUDIENCE;
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mock `pg` so no real DB connection is attempted.
// ---------------------------------------------------------------------------
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
  }));
  return { Pool };
});

// ---------------------------------------------------------------------------
// 3. Mock drizzle-orm/node-postgres so we control DB results.
// ---------------------------------------------------------------------------
const mockLimit = jest.fn();
const mockWhere = jest.fn(() => ({ limit: mockLimit }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: mockSelect })),
}));

// ---------------------------------------------------------------------------
// 4. Now import everything (env parsing runs here with the vars set above).
// ---------------------------------------------------------------------------
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sign a JWT with configurable overrides for negative-path tests. */
function signToken(
  sub: string = TEST_STELLAR,
  options: jwt.SignOptions = {},
): string {
  return jwt.sign({ sub }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
    ...options,
  });
}

/** Configure the drizzle mock to return a user row. */
function mockDbReturnsUser(): void {
  mockLimit.mockResolvedValueOnce([
    { id: TEST_USER_ID, stellarAddress: TEST_STELLAR },
  ]);
}

/** Configure the drizzle mock to return an empty result set. */
function mockDbReturnsNoUser(): void {
  mockLimit.mockResolvedValueOnce([]);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("requireAuth middleware", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("populates req.user and calls next for a valid JWT", async () => {
    mockDbReturnsUser();

    const token = signToken();
    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", `Bearer ${token}`);

    // The predictions route echoes req.user back in the response.
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: TEST_USER_ID,
      stellarAddress: TEST_STELLAR,
    });
  });

  // ── Missing token ─────────────────────────────────────────────────────────

  it("returns 401 with code=unauthenticated when Authorization header is absent", async () => {
    const res = await request(app).get("/api/predictions");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("returns 401 when Authorization header lacks 'Bearer' prefix", async () => {
    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", "Token some-random-value");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  // ── Expired token ─────────────────────────────────────────────────────────

  it("returns 401 with code=unauthenticated for an expired token", async () => {
    // expiresIn: -1 creates a token that expired one second ago.
    const token = signToken(TEST_STELLAR, { expiresIn: -1 });

    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  // ── Forged / tampered token ───────────────────────────────────────────────

  it("returns 401 for a token signed with the wrong secret", async () => {
    const token = jwt.sign({ sub: TEST_STELLAR }, "wrong-secret-that-is-long-enough-32bytes!!", {
      algorithm: "HS256",
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      expiresIn: 3600,
    });

    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("returns 401 for a token with a completely invalid format", async () => {
    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", "Bearer not.a.jwt");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  // ── Wrong audience ────────────────────────────────────────────────────────

  it("returns 401 when the token audience does not match", async () => {
    const token = signToken(TEST_STELLAR, { audience: "wrong-audience" });

    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  // ── Wrong issuer ──────────────────────────────────────────────────────────

  it("returns 401 when the token issuer does not match", async () => {
    const token = signToken(TEST_STELLAR, { issuer: "evil-issuer" });

    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  // ── User not found in DB ──────────────────────────────────────────────────

  it("returns 401 when the JWT is valid but no matching user exists", async () => {
    mockDbReturnsNoUser();

    const token = signToken();
    const res = await request(app)
      .get("/api/predictions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });
});

// ---------------------------------------------------------------------------

describe("optionalAuth middleware", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("continues anonymously (authenticatedAs: null) when no token is provided", async () => {
    const res = await request(app).get("/api/markets");

    // Markets route is public; 200 expected even without a token.
    expect(res.status).toBe(200);
    expect(res.body.authenticatedAs).toBeNull();
  });

  it("populates req.user when a valid token is provided", async () => {
    mockDbReturnsUser();

    const token = signToken();
    const res = await request(app)
      .get("/api/markets")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticatedAs).toEqual({
      id: TEST_USER_ID,
      stellarAddress: TEST_STELLAR,
    });
  });

  it("returns 401 when an Authorization header is present but the token is invalid", async () => {
    const res = await request(app)
      .get("/api/markets")
      .set("Authorization", "Bearer this-is-garbage");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("returns 401 for an expired token even on an optional route", async () => {
    const token = signToken(TEST_STELLAR, { expiresIn: -1 });

    const res = await request(app)
      .get("/api/markets")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });
});
