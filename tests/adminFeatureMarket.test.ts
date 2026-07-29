/**
 * Tests for the admin feature/unfeature routes.
 *
 *   POST   /api/admin/markets/:id/feature
 *   DELETE /api/admin/markets/:id/feature
 *
 * Strategy:
 *  - Mock `src/services/marketFeatureService` so no real DB is needed.
 *  - Sign real JWTs (with role:"admin") to exercise the full requireAdmin path.
 *  - Mount `createAdminMarketsRouter()` directly on a minimal express app so
 *    the rate-limit ceiling can be lowered for the 429 test.
 */

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../src/services/marketFeatureService", () => ({
  featureMarket: jest.fn(),
  unfeatureMarket: jest.fn(),
  listFeaturedMarkets: jest.fn(),
  MarketNotFoundError: class MarketNotFoundError extends Error {},
  MarketArchivedError: class MarketArchivedError extends Error {
    readonly status = 400;
    readonly code = "market_archived";
    constructor(marketId?: string) {
      super(`Market ${marketId ?? "unknown"} is archived and cannot be featured`);
      this.name = "MarketArchivedError";
    }
  },
  DrizzleMarketFeatureRepository: class {},
  DEFAULT_FEATURED_LIMIT: 6,
  MAX_FEATURED_LIMIT: 20,
}));

import {
  featureMarket,
  unfeatureMarket,
  MarketNotFoundError,
  MarketArchivedError,
} from "../src/services/marketFeatureService";
import { createAdminMarketsRouter } from "../src/routes/admin/markets";
import { errorHandler } from "../src/middleware/errorHandler";

const mockFeature = featureMarket as jest.MockedFunction<typeof featureMarket>;
const mockUnfeature = unfeatureMarket as jest.MockedFunction<typeof unfeatureMarket>;

// ── DB mock (prevents Pool connection at import time) ────────────────────────
jest.mock("../src/db/client", () => ({ db: {} }));

// ── JWT fixtures ────────────────────────────────────────────────────────────
const SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDR = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDR, role: "user" });

// ── App factory ─────────────────────────────────────────────────────────────
function makeApp(rateLimitPerMinute = 60): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "admin-feature-req";
    next();
  });
  app.use("/api/admin/markets", createAdminMarketsRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
});

// ── Auth guard ──────────────────────────────────────────────────────────────
describe("requireAdmin guard", () => {
  it("returns 403 with no Authorization header (POST)", async () => {
    const res = await request(makeApp()).post("/api/admin/markets/mkt-1/feature");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
    expect(mockFeature).not.toHaveBeenCalled();
  });

  it("returns 403 with no Authorization header (DELETE)", async () => {
    const res = await request(makeApp()).delete("/api/admin/markets/mkt-1/feature");
    expect(res.status).toBe(403);
  });

  it("returns 403 with a non-admin JWT", async () => {
    const res = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with a JWT signed by a different secret", async () => {
    const forged = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      "not-the-real-secret-but-32-chars-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with an expired JWT", async () => {
    const expired = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      SECRET,
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: -1 },
    );
    const res = await request(makeApp())
      .delete("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(403);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────
describe("validation", () => {
  it("returns 400 when the id is empty after trim", async () => {
    const res = await request(makeApp())
      .post("/api/admin/markets/%20/feature")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "req-empty");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.requestId).toBe("req-empty");
  });
});

// ── POST /:id/feature — happy path & semantics ──────────────────────────────
describe("POST /api/admin/markets/:id/feature — success", () => {
  it("returns 200 with FeatureMutationResult when the market transitions", async () => {
    mockFeature.mockResolvedValue({
      marketId: "mkt-1",
      featured: true,
      featuredAt: "2026-06-28T12:00:00.000Z",
      featuredBy: ADMIN_ADDR,
      changed: true,
    });

    const res = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        marketId: "mkt-1",
        featured: true,
        featuredAt: "2026-06-28T12:00:00.000Z",
        featuredBy: ADMIN_ADDR,
        changed: true,
      },
    });
    expect(mockFeature).toHaveBeenCalledTimes(1);
    expect(mockFeature).toHaveBeenCalledWith("mkt-1", ADMIN_ADDR, expect.objectContaining({ ip: expect.any(String) }));
  });

  it("is idempotent — feature twice yields changed:false without an error", async () => {
    mockFeature.mockResolvedValueOnce({
      marketId: "mkt-1",
      featured: true,
      featuredAt: "2026-06-28T12:00:00.000Z",
      featuredBy: ADMIN_ADDR,
      changed: true,
    });

    const first = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(first.status).toBe(200);
    expect(first.body.data.changed).toBe(true);

    mockFeature.mockResolvedValueOnce({
      marketId: "mkt-1",
      featured: true,
      featuredAt: "2026-06-28T12:00:00.000Z",
      featuredBy: ADMIN_ADDR,
      changed: false,
    });

    const second = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(second.status).toBe(200);
    expect(second.body.data.changed).toBe(false);
  });

  it("returns 404 when MarketNotFoundError is raised", async () => {
    mockFeature.mockImplementation(async () => {
      throw new MarketNotFoundError("missing");
    });

    const res = await request(makeApp())
      .post("/api/admin/markets/missing/feature")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "missing-123");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", requestId: "missing-123" } });
  });

  it("returns 400 with code=market_archived when MarketArchivedError is raised", async () => {
    mockFeature.mockImplementation(async () => {
      throw new MarketArchivedError("mkt-archived");
    });

    const res = await request(makeApp())
      .post("/api/admin/markets/mkt-archived/feature")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "archived-456");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("market_archived");
    expect(res.body.error.message).toMatch(/archived and cannot be featured/);
    expect(res.body.error.requestId).toBe("archived-456");
  });

  it("lets unexpected errors bubble to the global handler (500)", async () => {
    mockFeature.mockRejectedValue(new Error("db down"));

    const res = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
  });
});

// ── DELETE /:id/feature — happy path & semantics ────────────────────────────
describe("DELETE /api/admin/markets/:id/feature — success", () => {
  it("returns 200 with FeatureMutationResult when the market transitions", async () => {
    mockUnfeature.mockResolvedValue({
      marketId: "mkt-1",
      featured: false,
      featuredAt: null,
      featuredBy: null,
      changed: true,
    });

    const res = await request(makeApp())
      .delete("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        marketId: "mkt-1",
        featured: false,
        featuredAt: null,
        featuredBy: null,
        changed: true,
      },
    });
    expect(mockUnfeature).toHaveBeenCalledWith("mkt-1", ADMIN_ADDR, expect.objectContaining({ ip: expect.any(String) }));
  });

  it("is idempotent — unfeature twice yields changed:false", async () => {
    mockUnfeature.mockResolvedValueOnce({
      marketId: "mkt-1",
      featured: false,
      featuredAt: null,
      featuredBy: null,
      changed: true,
    });

    await request(makeApp())
      .delete("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    mockUnfeature.mockResolvedValueOnce({
      marketId: "mkt-1",
      featured: false,
      featuredAt: null,
      featuredBy: null,
      changed: false,
    });

    const second = await request(makeApp())
      .delete("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(second.status).toBe(200);
    expect(second.body.data.changed).toBe(false);
  });

  it("returns 404 for a missing market", async () => {
    mockUnfeature.mockImplementation(async () => {
      throw new MarketNotFoundError("ghost");
    });

    const res = await request(makeApp())
      .delete("/api/admin/markets/ghost/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────────
describe("rate limiting", () => {
  it("returns 429 after the per-token ceiling is exceeded", async () => {
    mockFeature.mockResolvedValue({
      marketId: "mkt-1",
      featured: true,
      featuredAt: "2026-06-28T12:00:00.000Z",
      featuredBy: ADMIN_ADDR,
      changed: true,
    });

    // 2 requests/min so the test runs fast.
    const app = makeApp(2);

    await request(app)
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);
    await request(app)
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    const third = await request(app)
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });

  it("isolates buckets per admin token", async () => {
    mockFeature.mockResolvedValue({
      marketId: "mkt-1",
      featured: true,
      featuredAt: "2026-06-28T12:00:00.000Z",
      featuredBy: ADMIN_ADDR,
      changed: true,
    });

    const otherAdminJwt = signJwt({
      sub: "GOTHERADMINADMINADMINADMINADMINADMINADMINADMINADMINADMIN",
      role: "admin",
    });

    const app = makeApp(1);
    const a = await request(app)
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);
    const b = await request(app)
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${otherAdminJwt}`);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

// ── Response surface ────────────────────────────────────────────────────────
describe("response surface", () => {
  it("exposes the standard rate-limit headers on successful responses", async () => {
    mockFeature.mockResolvedValue({
      marketId: "mkt-1",
      featured: true,
      featuredAt: "2026-06-28T12:00:00.000Z",
      featuredBy: ADMIN_ADDR,
      changed: true,
    });

    const res = await request(makeApp())
      .post("/api/admin/markets/mkt-1/feature")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });

  it("returns the documented envelope shape on validation failure", async () => {
    const res = await request(makeApp())
      .post("/api/admin/markets/%20/feature")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "shape-test");

    expect(res.body).toMatchObject({
      error: {
        code: "validation_error",
        details: expect.any(Array),
        requestId: "shape-test",
      },
    });
  });
});
