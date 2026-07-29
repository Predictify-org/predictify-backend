/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @file users.test.ts
 *
 * Unit tests for GET /api/users endpoints, focusing on:
 *   - ETag / 304 conditional-GET behaviour (the primary concern of this PR)
 *   - Basic status codes and response shapes
 *   - Input validation
 *
 * All external dependencies (services, auth, metrics, timeouts) are mocked so
 * the tests are fast and hermetic — no real DB or Redis required.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mock all service / middleware dependencies before importing the router
// ---------------------------------------------------------------------------

// Auth middleware — allow all requests through in tests
jest.mock("../../middleware/requireAuth", () => ({
  requireAuthForbidden: (
    req: any,
    _res: any,
    next: any,
  ) => {
    req.user = { id: "user-test-id", stellarAddress: "GABC123" };
    next();
  },
}));

// Timeout middleware — no-op in tests
jest.mock("../../middleware/timeout", () => ({
  requestTimeout: () => (_req: any, _res: any, next: any) => next(),
}));

// Metrics middleware — no-op in tests
jest.mock("../../metrics/usersMetrics", () => ({
  usersMetricsMiddleware: (_req: any, _res: any, next: any) => next(),
}));

// Rate limit — no-op in tests
jest.mock("../../middleware/rateLimit", () => ({
  createPerUserRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

// User service
jest.mock("../../services/userService");
import * as userService from "../../services/userService";

// Access log — no-op (avoids logger noise in tests)
jest.mock("../../middleware/accessLog", () => ({
  accessLog: (_req: any, _res: any, next: any) => next(),
}));

// Request context
jest.mock("../../lib/requestContext", () => ({
  getRequestId: () => "test-req-id",
}));

// Logger — silent in tests
jest.mock("../../config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Import the router AFTER mocks are set up
// ---------------------------------------------------------------------------
import { usersRouter } from "../../routes/users";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  // Disable Express's own built-in ETag (matches production config)
  app.set("etag", false);
  app.use("/api/users", usersRouter);
  return app;
}

const VALID_ADDRESS = "GABC1234567890DEFGHIJKLMNOPQRSTUVWXY";
const MOCK_PROFILE = {
  stellarAddress: VALID_ADDRESS,
  createdAt: "2026-01-01T00:00:00.000Z",
  totals: { prediction_count: 5, claim_count: 2 },
};
const MOCK_PUBLIC_PROFILE = {
  id: "user-uuid-1",
  stellarAddress: VALID_ADDRESS,
  joinedAt: "2025-01-01T00:00:00.000Z",
  predictions: [],
  totals: { prediction_count: 0, claim_count: 0 },
};
const MOCK_PREDICTION_PAGE = {
  data: [
    {
      id: "pred-uuid-1",
      marketId: "market-abc",
      status: "confirmed",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  nextCursor: null,
};

// ---------------------------------------------------------------------------
// GET /api/users — ETag + 304 (list)
// ---------------------------------------------------------------------------

const MOCK_USERS_PAGE = {
  data: [
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      stellarAddress: VALID_ADDRESS,
      createdAt: "2026-06-27T12:00:00.000Z",
    },
  ],
  nextCursor: null as string | null,
};

describe("GET /api/users", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns 200 with ETag and Cache-Control on first request", async () => {
    (userService.listUsers as any).mockResolvedValueOnce(MOCK_USERS_PAGE);

    const res = await request(app).get("/api/users");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(MOCK_USERS_PAGE.data);
    expect(res.body.nextCursor).toBeNull();
    expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches current ETag", async () => {
    (userService.listUsers as any).mockResolvedValueOnce(MOCK_USERS_PAGE);

    const first = await request(app).get("/api/users");
    const etag = first.headers["etag"] as string;

    (userService.listUsers as any).mockResolvedValueOnce(MOCK_USERS_PAGE);

    const second = await request(app).get("/api/users").set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("returns 200 when If-None-Match does not match", async () => {
    (userService.listUsers as any).mockResolvedValueOnce(MOCK_USERS_PAGE);

    const res = await request(app)
      .get("/api/users")
      .set("If-None-Match", '"000000stale000000"');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(MOCK_USERS_PAGE.data);
  });

  it("ETag changes when list payload changes", async () => {
    (userService.listUsers as any).mockResolvedValueOnce(MOCK_USERS_PAGE);
    const first = await request(app).get("/api/users");

    (userService.listUsers as any).mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });
    const second = await request(app).get("/api/users");

    expect(first.headers["etag"]).not.toBe(second.headers["etag"]);
  });

  it("returns 400 for invalid limit", async () => {
    const res = await request(app).get("/api/users").query({ limit: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/me — ETag + 304
// ---------------------------------------------------------------------------

describe("GET /api/users/me", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns 200 with ETag and Cache-Control on first request", async () => {
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(MOCK_PROFILE);
    expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches current ETag", async () => {
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    // First request — grab the ETag
    const first = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token");

    const etag = first.headers["etag"] as string;
    expect(etag).toBeDefined();

    // Service must be called again for second request
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    // Second request — send ETag back
    const second = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe(""); // 304 must have no body
  });

  it("returns 200 when If-None-Match does not match", async () => {
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token")
      .set("If-None-Match", '"000000stale000000"');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(MOCK_PROFILE);
  });

  it("returns 304 when If-None-Match is sent without surrounding quotes", async () => {
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    const first = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token");

    // Strip quotes — the middleware must still match
    const rawHash = (first.headers["etag"] as string).replace(/"/g, "");

    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    const second = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token")
      .set("If-None-Match", rawHash);

    expect(second.status).toBe(304);
  });

  it("ETag changes when response payload changes", async () => {
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: MOCK_PROFILE,
    });

    const first = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token");

    const updatedProfile = { ...MOCK_PROFILE, totals: { prediction_count: 6, claim_count: 3 } };
    (userService.getCurrentUserProfile as any).mockResolvedValueOnce({
      ok: true,
      value: updatedProfile,
    });

    const second = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token");

    expect(first.headers["etag"]).not.toBe(second.headers["etag"]);
  });

  it("returns 500 when service throws", async () => {
    (userService.getCurrentUserProfile as any).mockRejectedValueOnce(
      new Error("DB error"),
    );

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:address/predictions — ETag + 304
// ---------------------------------------------------------------------------

describe("GET /api/users/:address/predictions", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns 200 with ETag and Cache-Control on first request", async () => {
    (userService.getUserByAddress as any).mockResolvedValueOnce({ id: "user-id-1" });
    (userService.getUserPredictions as any).mockResolvedValueOnce(MOCK_PREDICTION_PAGE);

    const res = await request(app).get(`/api/users/${VALID_ADDRESS}/predictions`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(MOCK_PREDICTION_PAGE.data);
    expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    (userService.getUserByAddress as any).mockResolvedValueOnce({ id: "user-id-1" });
    (userService.getUserPredictions as any).mockResolvedValueOnce(MOCK_PREDICTION_PAGE);

    const first = await request(app).get(`/api/users/${VALID_ADDRESS}/predictions`);
    const etag = first.headers["etag"] as string;

    (userService.getUserByAddress as any).mockResolvedValueOnce({ id: "user-id-1" });
    (userService.getUserPredictions as any).mockResolvedValueOnce(MOCK_PREDICTION_PAGE);

    const second = await request(app)
      .get(`/api/users/${VALID_ADDRESS}/predictions`)
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("returns 200 when If-None-Match does not match", async () => {
    (userService.getUserByAddress as any).mockResolvedValueOnce({ id: "user-id-1" });
    (userService.getUserPredictions as any).mockResolvedValueOnce(MOCK_PREDICTION_PAGE);

    const res = await request(app)
      .get(`/api/users/${VALID_ADDRESS}/predictions`)
      .set("If-None-Match", '"stale-etag"');

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid Stellar address", async () => {
    const res = await request(app).get("/api/users/INVALID_ADDR/predictions");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_address");
  });

  it("returns 404 when user not found", async () => {
    (userService.getUserByAddress as any).mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/users/${VALID_ADDRESS}/predictions`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for invalid status query param", async () => {
    const res = await request(app)
      .get(`/api/users/${VALID_ADDRESS}/predictions`)
      .query({ status: "invalid_status" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for limit exceeding max", async () => {
    const res = await request(app)
      .get(`/api/users/${VALID_ADDRESS}/predictions`)
      .query({ limit: 101 });
    expect(res.status).toBe(400);
  });

  it("handles service error gracefully", async () => {
    (userService.getUserByAddress as any).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get(`/api/users/${VALID_ADDRESS}/predictions`);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:stellarAddress/profile — ETag + 304
// ---------------------------------------------------------------------------

describe("GET /api/users/:stellarAddress/profile", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns 200 with ETag and Cache-Control on first request", async () => {
    (userService.getUserProfile as any).mockResolvedValueOnce(MOCK_PUBLIC_PROFILE);

    const res = await request(app).get(`/api/users/${VALID_ADDRESS}/profile`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(MOCK_PUBLIC_PROFILE);
    expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    (userService.getUserProfile as any).mockResolvedValueOnce(MOCK_PUBLIC_PROFILE);

    const first = await request(app).get(`/api/users/${VALID_ADDRESS}/profile`);
    const etag = first.headers["etag"] as string;

    (userService.getUserProfile as any).mockResolvedValueOnce(MOCK_PUBLIC_PROFILE);

    const second = await request(app)
      .get(`/api/users/${VALID_ADDRESS}/profile`)
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("returns 200 when If-None-Match does not match", async () => {
    (userService.getUserProfile as any).mockResolvedValueOnce(MOCK_PUBLIC_PROFILE);

    const res = await request(app)
      .get(`/api/users/${VALID_ADDRESS}/profile`)
      .set("If-None-Match", '"000stale000"');

    expect(res.status).toBe(200);
  });

  it("ETag is deterministic — same payload yields same ETag across requests", async () => {
    (userService.getUserProfile as any).mockResolvedValueOnce(MOCK_PUBLIC_PROFILE);
    const first = await request(app).get(`/api/users/${VALID_ADDRESS}/profile`);

    (userService.getUserProfile as any).mockResolvedValueOnce(MOCK_PUBLIC_PROFILE);
    const second = await request(app).get(`/api/users/${VALID_ADDRESS}/profile`);

    expect(first.headers["etag"]).toBe(second.headers["etag"]);
  });

  it("returns 400 for invalid Stellar address", async () => {
    const res = await request(app).get("/api/users/NOT_VALID/profile");
    expect(res.status).toBe(400);
  });

  it("returns 404 when user not found", async () => {
    (userService.getUserProfile as any).mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/users/${VALID_ADDRESS}/profile`);
    expect(res.status).toBe(404);
  });

  it("handles service error gracefully", async () => {
    (userService.getUserProfile as any).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get(`/api/users/${VALID_ADDRESS}/profile`);
    expect(res.status).toBe(500);
  });
});
