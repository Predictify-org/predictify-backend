/**
 * Tests for the admin sample-market seed route.
 *
 *   POST /api/admin/seed
 *
 * Strategy:
 *  - Mock `src/services/seedService` so no real DB is needed.
 *  - Sign real JWTs (role:"admin") to exercise the full requireAdmin path.
 *  - Mount `createAdminSeedRouter()` directly so the rate-limit ceiling can be
 *    lowered for the 429 test.
 */

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../src/services/seedService", () => ({
  seedSampleMarkets: jest.fn(),
  SeedNotAllowedError: class SeedNotAllowedError extends Error {
    readonly status = 403;
    readonly code = "seed_not_allowed";
    constructor() {
      super("Market seeding is disabled in production");
      this.name = "SeedNotAllowedError";
    }
  },
}));

// Prevent a Pool connection at import time.
jest.mock("../src/db/client", () => ({ db: {} }));

// Verify admin JWTs with the test secret directly. This keeps the test isolated
// from the key-ring/env wiring (which is unrelated to the seed endpoint) while
// still exercising the real `requireAdmin` middleware end-to-end.
jest.mock("../src/services/jwtService", () => {
  const jwtLib = jest.requireActual<typeof import("jsonwebtoken")>("jsonwebtoken");
  return {
    verifyAccessToken: (token: string) =>
      jwtLib.verify(token, process.env.JWT_SECRET as string, {
        algorithms: ["HS256"],
        issuer: process.env.JWT_ISSUER || "predictify",
        audience: process.env.JWT_AUDIENCE || "predictify-app",
      }),
  };
});

import { seedSampleMarkets, SeedNotAllowedError } from "../src/services/seedService";
import { createAdminSeedRouter } from "../src/routes/admin/seed";
import { errorHandler } from "../src/middleware/errorHandler";
import { env } from "../src/config/env";

const mockSeed = seedSampleMarkets as jest.MockedFunction<typeof seedSampleMarkets>;

// ── JWT fixtures ────────────────────────────────────────────────────────────
const SECRET = process.env.JWT_SECRET || "test-secret-with-at-least-32-characters";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDR = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDR, role: "user" });

const SEED_RESULT = {
  requested: 5,
  inserted: 5,
  skipped: 0,
  batchVersion: 1,
  insertedIds: ["seed-market-001"],
  markets: [
    {
      id: "seed-market-001",
      question: "q",
      status: "open",
      resolutionTime: "2026-07-30T10:00:00.000Z",
    },
  ],
};

function makeApp(rateLimitPerMinute = 30): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "admin-seed-req";
    next();
  });
  app.use("/api/admin/seed", createAdminSeedRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

// ── Auth guard ──────────────────────────────────────────────────────────────
describe("requireAdmin guard", () => {
  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).post("/api/admin/seed");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("returns 403 with a non-admin JWT", async () => {
    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("returns 403 with an expired JWT", async () => {
    const expired = jwt.sign({ sub: ADMIN_ADDR, role: "admin" }, SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: -1,
    });
    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(403);
  });
});

// ── Success & idempotency ───────────────────────────────────────────────────
describe("POST /api/admin/seed", () => {
  it("returns 200 with the seed result and forwards admin context", async () => {
    mockSeed.mockResolvedValue(SEED_RESULT);

    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "seed-req-1")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: SEED_RESULT });
    expect(mockSeed).toHaveBeenCalledTimes(1);
    expect(mockSeed).toHaveBeenCalledWith({
      adminAddress: ADMIN_ADDR,
      ip: expect.any(String),
      correlationId: "seed-req-1",
    });
  });

  it("uses the first X-Forwarded-For hop as the client IP", async () => {
    mockSeed.mockResolvedValue(SEED_RESULT);

    await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Forwarded-For", "203.0.113.7, 70.41.3.18")
      .send({});

    expect(mockSeed).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.7" }),
    );
  });

  it("is idempotent — a repeat call reports inserted:0", async () => {
    mockSeed.mockResolvedValueOnce({ ...SEED_RESULT, inserted: 0, skipped: 5, insertedIds: [] });

    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.inserted).toBe(0);
    expect(res.body.data.skipped).toBe(5);
  });

  it("returns 400 when the body contains unexpected fields", async () => {
    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "bad-body")
      .send({ count: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.requestId).toBe("bad-body");
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("maps SeedNotAllowedError to 403 seed_not_allowed", async () => {
    mockSeed.mockRejectedValue(new SeedNotAllowedError());

    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("seed_not_allowed");
  });

  it("lets unexpected errors bubble to the global handler (500)", async () => {
    mockSeed.mockRejectedValue(new Error("db down"));

    const res = await request(makeApp())
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(500);
  });
});

// ── Production guard ────────────────────────────────────────────────────────
describe("production guard", () => {
  it("returns 404 before auth runs when NODE_ENV=production", async () => {
    const original = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    try {
      // No Authorization header — the route must hide itself, not 403.
      const res = await request(makeApp()).post("/api/admin/seed").send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(mockSeed).not.toHaveBeenCalled();
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = original;
    }
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────────
describe("rate limiting", () => {
  it("returns 429 after the per-token ceiling is exceeded", async () => {
    mockSeed.mockResolvedValue(SEED_RESULT);
    const app = makeApp(2);

    await request(app).post("/api/admin/seed").set("Authorization", `Bearer ${adminJwt}`).send({});
    await request(app).post("/api/admin/seed").set("Authorization", `Bearer ${adminJwt}`).send({});
    const third = await request(app)
      .post("/api/admin/seed")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });
});
