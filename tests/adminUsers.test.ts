/**
 * Tests for GET /api/admin/users/:address
 *
 * Strategy:
 *  - Mock src/services/adminUsersService so no database is needed.
 *  - Sign real JWTs with the test JWT_SECRET so requireAdmin executes its
 *    full verification path.
 *  - Mount createAdminUsersRouter() directly on a minimal Express app so we
 *    can inject a low rate-limit ceiling for the 429 test.
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminUsersRouter } from "../src/routes/adminUsers";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Service mock ──────────────────────────────────────────────────────────────

jest.mock("../src/services/adminUsersService");

import {
  getAdminUserView,
  writeAuditLog,
} from "../src/services/adminUsersService";

const mockGetAdminUserView = getAdminUserView as jest.MockedFunction<typeof getAdminUserView>;
const mockWriteAuditLog = writeAuditLog as jest.MockedFunction<typeof writeAuditLog>;

// ── DB mock (prevents Pool connection at import time) ─────────────────────────

jest.mock("../src/db/client", () => ({ db: {} }));

// ── JWT helpers ───────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS  = "GUSER88888888888888888888888888888888888888888888888888888";
const TARGET_ADDRESS = "GTARGET99999999999999999999999999999999999999999999999999";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt  = signJwt({ sub: USER_ADDRESS,  role: "user" });

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FULL_VIEW = {
  user: {
    id: "uuid-1",
    stellarAddress: TARGET_ADDRESS,
    createdAt: "2024-01-01T00:00:00.000Z",
  },
  predictions: [
    { id: "pred-1", marketId: "mkt-1", outcome: "yes", amount: "100", createdAt: "2024-01-02T00:00:00.000Z" },
  ],
  claims: [
    { id: "claim-1", marketId: "mkt-1", amount: "90", status: "pending", createdAt: "2024-01-03T00:00:00.000Z" },
  ],
  disputes: [
    { id: "dispute-1", marketId: "mkt-2", reason: "wrong outcome", status: "open", createdAt: "2024-01-04T00:00:00.000Z" },
  ],
  totals: { predictions: 1, claims: 1, disputes: 1 },
};

const EMPTY_VIEW = {
  user: null,
  predictions: [],
  claims: [],
  disputes: [],
  totals: { predictions: 0, claims: 0, disputes: 0 },
};

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(rateLimitPerMinute = 60): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/users", createAdminUsersRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("requireAdmin guard", () => {
  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).get(`/api/admin/users/${TARGET_ADDRESS}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 with a non-Bearer scheme", async () => {
    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Basic ${adminJwt}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with a non-admin JWT (role: user)", async () => {
    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 with a JWT signed by a different secret", async () => {
    const badToken = jwt.sign(
      { sub: ADMIN_ADDRESS, role: "admin" },
      "wrong-secret-at-least-32-characters-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${badToken}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with an expired JWT", async () => {
    const expired = jwt.sign(
      { sub: ADMIN_ADDRESS, role: "admin" },
      SECRET,
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: -1 },
    );
    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with a JWT missing the sub claim", async () => {
    const noSub = signJwt({ role: "admin" });
    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${noSub}`);
    expect(res.status).toBe(403);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("GET /api/admin/users/:address — success", () => {
  it("returns 200 with the aggregated user view", async () => {
    mockGetAdminUserView.mockResolvedValue(FULL_VIEW);

    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(FULL_VIEW);
  });

  it("calls getAdminUserView with the correct address", async () => {
    mockGetAdminUserView.mockResolvedValue(FULL_VIEW);

    await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(mockGetAdminUserView).toHaveBeenCalledWith(TARGET_ADDRESS, expect.anything());
  });

  it("writes an audit log entry with admin address and target address", async () => {
    mockGetAdminUserView.mockResolvedValue(FULL_VIEW);

    await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      ADMIN_ADDRESS,
      TARGET_ADDRESS,
      expect.anything(),
    );
  });

  it("returns empty arrays and null user for an unknown address", async () => {
    mockGetAdminUserView.mockResolvedValue(EMPTY_VIEW);

    const res = await request(makeApp())
      .get(`/api/admin/users/GUNKNOWN`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user).toBeNull();
    expect(res.body.data.predictions).toEqual([]);
    expect(res.body.data.totals).toEqual({ predictions: 0, claims: 0, disputes: 0 });
  });

  it("still writes audit log even when the user is not found", async () => {
    mockGetAdminUserView.mockResolvedValue(EMPTY_VIEW);

    await request(makeApp())
      .get(`/api/admin/users/GUNKNOWN`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe("response payload shape", () => {
  it("includes all required top-level fields", async () => {
    mockGetAdminUserView.mockResolvedValue(FULL_VIEW);

    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    const { data } = res.body;
    expect(data).toHaveProperty("user");
    expect(data).toHaveProperty("predictions");
    expect(data).toHaveProperty("claims");
    expect(data).toHaveProperty("disputes");
    expect(data).toHaveProperty("totals");
  });

  it("totals match the array lengths", async () => {
    mockGetAdminUserView.mockResolvedValue(FULL_VIEW);

    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    const { data } = res.body;
    expect(data.totals.predictions).toBe(data.predictions.length);
    expect(data.totals.claims).toBe(data.claims.length);
    expect(data.totals.disputes).toBe(data.disputes.length);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  it("propagates service errors as 500 via errorHandler", async () => {
    mockGetAdminUserView.mockRejectedValue(new Error("db down"));

    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
  });

  it("does not write audit log when the service throws", async () => {
    mockGetAdminUserView.mockRejectedValue(new Error("db down"));

    await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 after the per-admin limit is exceeded", async () => {
    mockGetAdminUserView.mockResolvedValue(EMPTY_VIEW);

    // Use a limit of 2 so the test runs quickly (not 60 real requests)
    const app = makeApp(2);

    await request(app).get(`/api/admin/users/${TARGET_ADDRESS}`).set("Authorization", `Bearer ${adminJwt}`);
    await request(app).get(`/api/admin/users/${TARGET_ADDRESS}`).set("Authorization", `Bearer ${adminJwt}`);

    const res = await request(app)
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });

  it("includes rate-limit headers in successful responses", async () => {
    mockGetAdminUserView.mockResolvedValue(EMPTY_VIEW);

    const res = await request(makeApp())
      .get(`/api/admin/users/${TARGET_ADDRESS}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    // draft-6 standard headers
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });
});
