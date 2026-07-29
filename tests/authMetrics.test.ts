/**
 * tests/authMetrics.test.ts
 *
 * Focused tests for the per-endpoint Prometheus metrics on /api/auth.
 *
 * Verifies that `authEndpointRequestsTotal` (Counter) and
 * `authEndpointDuration` (Histogram) are incremented/observed for each
 * route handler in src/routes/auth.ts:
 *
 *   POST /challenge
 *   POST /verify
 *   POST /refresh
 *   POST /logout
 *   POST /wallet/logout
 *
 * Strategy: mount `authRouter` directly on a small Express app (same pattern
 * as usersMetrics.test.ts) with all service and middleware dependencies mocked
 * so the tests exercise only the route + metrics wiring. No real DB, Redis, or
 * Stellar RPC required.
 *
 * Coverage matrix
 * ───────────────────────────────────────────────────────────────────────────
 *   ✓  counter increments by 1 on success (200 / 201 / 204) for every route
 *   ✓  counter increments for client errors (422 validation failure)
 *   ✓  histogram receives an observation for every request
 *   ✓  histogram labels include method, route, and status
 *   ✓  counter labels include method, route, and status
 *   ✓  metric names are present in Prometheus exposition output
 *   ✓  counter increments across repeated requests
 */

// ---------------------------------------------------------------------------
// 1. Env vars — must be set before any project imports
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "auth-metrics-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mock pg so the module graph cannot open a real socket
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
// 3. Mock drizzle-orm so requireAuth DB lookups are controllable
// ---------------------------------------------------------------------------
const drizzleLimit = jest.fn();
const drizzleWhere = jest.fn(() => ({ limit: drizzleLimit }));
const drizzleFrom = jest.fn(() => ({ where: drizzleWhere }));
const drizzleSelect = jest.fn(() => ({ from: drizzleFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: drizzleSelect })),
}));

jest.mock("../src/db/client", () => ({
  db: { select: jest.fn() },
  pool: { on: jest.fn(), end: jest.fn(), query: jest.fn() },
}));

// ---------------------------------------------------------------------------
// 4. Mock auth services
// ---------------------------------------------------------------------------
jest.mock("../src/services/authChallengeService", () => ({
  __esModule: true,
  createChallenge: jest.fn(),
}));

jest.mock("../src/services/authVerifyService", () => ({
  __esModule: true,
  verifyChallengeAndIssueJwt: jest.fn(),
}));

jest.mock("../src/services/refreshTokenService", () => ({
  __esModule: true,
  rotateRefreshToken: jest.fn(),
  revokeFamily: jest.fn(),
}));

// ---------------------------------------------------------------------------
// 5. No-op middleware shims (accessLog, timeout, loginRateLimit, rateLimiter)
// ---------------------------------------------------------------------------
jest.mock("../src/middleware/accessLog", () => ({
  accessLog: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../src/middleware/timeout", () => ({
  requestTimeout: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../src/middleware/loginRateLimit", () => ({
  loginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../src/middleware/rateLimit", () => ({
  createPerUserRateLimiter:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Silence logger output during tests
jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// 6. Project imports (env + mocks are in place)
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import { authRouter } from "../src/routes/auth";
import { errorHandler } from "../src/middleware/errorHandler";
import { createChallenge } from "../src/services/authChallengeService";
import { verifyChallengeAndIssueJwt } from "../src/services/authVerifyService";
import {
  rotateRefreshToken,
  revokeFamily,
} from "../src/services/refreshTokenService";
import {
  authEndpointRequestsTotal,
  authEndpointDuration,
  register,
} from "../src/metrics/registry";

// Typed mock helpers
const mockCreateChallenge = createChallenge as jest.MockedFunction<typeof createChallenge>;
const mockVerify = verifyChallengeAndIssueJwt as jest.MockedFunction<typeof verifyChallengeAndIssueJwt>;
const mockRotate = rotateRefreshToken as jest.MockedFunction<typeof rotateRefreshToken>;
const mockRevoke = revokeFamily as jest.MockedFunction<typeof revokeFamily>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  // Expose /api/metrics for exposition-format assertions
  app.get("/api/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the current value for a given label set from the counter's hashMap.
 * The prom-client internal key format is sorted "key:value," pairs.
 */
function counterValue(
  counter: typeof authEndpointRequestsTotal,
  labels: Record<string, string>,
): number {
  const key =
    Object.keys(labels)
      .sort()
      .map((k) => `${k}:${labels[k]}`)
      .join(",") + ",";
  const entry = (counter as unknown as { hashMap: Record<string, { value: number }> }).hashMap[key];
  return entry?.value ?? 0;
}

// Shared test fixtures
const VALID_STELLAR = "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6";
const VALID_NONCE   = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_SIG     = "dGVzdA=="; // base64("test") — accepted by the mock
const VALID_TOKEN   = "opaque-refresh-token";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Per-endpoint Prometheus metrics on /api/auth", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Metric registration ─────────────────────────────────────────────────

  describe("metric registration", () => {
    it("exposes auth_endpoint_requests_total in Prometheus output", async () => {
      const res = await request(app).get("/api/metrics");
      expect(res.text).toContain("auth_endpoint_requests_total");
    });

    it("exposes auth_endpoint_duration_seconds in Prometheus output", async () => {
      const res = await request(app).get("/api/metrics");
      expect(res.text).toContain("auth_endpoint_duration_seconds");
    });

    it("declares explicit histogram buckets", async () => {
      // Make a request so the histogram emits bucket lines in the exposition output.
      mockCreateChallenge.mockResolvedValueOnce({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });
      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: VALID_STELLAR });

      const res = await request(app).get("/api/metrics");
      // At minimum the 0.01 and 10 boundary buckets must be present
      expect(res.text).toMatch(/auth_endpoint_duration_seconds_bucket\{.*le="0\.01"/);
      expect(res.text).toMatch(/auth_endpoint_duration_seconds_bucket\{.*le="10"/);
    });
  });

  // ── POST /challenge ─────────────────────────────────────────────────────

  describe("POST /api/auth/challenge", () => {
    it("increments counter with method=POST, route=/challenge, status=201", async () => {
      mockCreateChallenge.mockResolvedValueOnce({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/challenge",
        status: "201",
      });

      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: VALID_STELLAR });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/challenge",
        status: "201",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=422 on validation failure", async () => {
      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/challenge",
        status: "422",
      });

      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: "not-a-valid-stellar-address" });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/challenge",
        status: "422",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram for /challenge", async () => {
      mockCreateChallenge.mockResolvedValueOnce({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });

      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: VALID_STELLAR });

      const metrics = await authEndpointDuration.get();
      const sample = metrics.values.find(
        (v) => v.labels.route === "/challenge" && v.labels.method === "POST",
      );
      expect(sample).toBeDefined();
    });

    it("increments counter across repeated requests", async () => {
      mockCreateChallenge.mockResolvedValue({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/challenge",
        status: "201",
      });

      await request(app).post("/api/auth/challenge").send({ stellarAddress: VALID_STELLAR });
      await request(app).post("/api/auth/challenge").send({ stellarAddress: VALID_STELLAR });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/challenge",
        status: "201",
      });
      expect(after).toBe(before + 2);
    });
  });

  // ── POST /verify ────────────────────────────────────────────────────────

  describe("POST /api/auth/verify", () => {
    it("increments counter with status=200 on successful verify", async () => {
      mockVerify.mockResolvedValueOnce({
        ok: true,
        value: {
          accessToken: "tok",
          expiresIn: 3600,
          refreshToken: "refresh-tok",
        },
      });

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/verify",
        status: "200",
      });

      await request(app)
        .post("/api/auth/verify")
        .send({
          stellarAddress: VALID_STELLAR,
          nonce: VALID_NONCE,
          signature: VALID_SIG,
        });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/verify",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=422 on validation failure", async () => {
      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/verify",
        status: "422",
      });

      // Missing required fields
      await request(app).post("/api/auth/verify").send({});

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/verify",
        status: "422",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram for /verify", async () => {
      mockVerify.mockResolvedValueOnce({
        ok: true,
        value: {
          accessToken: "tok",
          expiresIn: 3600,
          refreshToken: "refresh-tok",
        },
      });

      await request(app)
        .post("/api/auth/verify")
        .send({
          stellarAddress: VALID_STELLAR,
          nonce: VALID_NONCE,
          signature: VALID_SIG,
        });

      const metrics = await authEndpointDuration.get();
      const sample = metrics.values.find(
        (v) => v.labels.route === "/verify" && v.labels.method === "POST",
      );
      expect(sample).toBeDefined();
    });

    it("increments counter with error status when service returns !ok", async () => {
      // Return a RouteError (plain object with `kind`) so the errorHandler
      // maps it to 401. The auth route does `throw result.error` which the
      // errorHandler catches via isRouteError().
      mockVerify.mockResolvedValueOnce({
        ok: false,
        error: { kind: "Unauthorized", message: "Signature did not match" } as never,
      });

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/verify",
        status: "401",
      });

      await request(app)
        .post("/api/auth/verify")
        .send({
          stellarAddress: VALID_STELLAR,
          nonce: VALID_NONCE,
          signature: VALID_SIG,
        });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/verify",
        status: "401",
      });
      expect(after).toBe(before + 1);
    });
  });

  // ── POST /refresh ───────────────────────────────────────────────────────

  describe("POST /api/auth/refresh", () => {
    it("increments counter with status=200 on successful token rotation", async () => {
      mockRotate.mockResolvedValueOnce({
        ok: true,
        value: {
          accessToken: "new-access",
          expiresIn: 3600,
          refreshToken: "new-refresh",
        },
      });

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/refresh",
        status: "200",
      });

      await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: VALID_TOKEN });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/refresh",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=422 when refreshToken is missing", async () => {
      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/refresh",
        status: "422",
      });

      await request(app).post("/api/auth/refresh").send({});

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/refresh",
        status: "422",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram for /refresh", async () => {
      mockRotate.mockResolvedValueOnce({
        ok: true,
        value: {
          accessToken: "new-access",
          expiresIn: 3600,
          refreshToken: "new-refresh",
        },
      });

      await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: VALID_TOKEN });

      const metrics = await authEndpointDuration.get();
      const sample = metrics.values.find(
        (v) => v.labels.route === "/refresh" && v.labels.method === "POST",
      );
      expect(sample).toBeDefined();
    });
  });

  // ── POST /logout ────────────────────────────────────────────────────────

  describe("POST /api/auth/logout", () => {
    it("increments counter with status=204 on successful logout", async () => {
      mockRevoke.mockResolvedValueOnce(undefined);

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/logout",
        status: "204",
      });

      await request(app)
        .post("/api/auth/logout")
        .send({ refreshToken: VALID_TOKEN });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/logout",
        status: "204",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=422 when refreshToken is missing", async () => {
      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/logout",
        status: "422",
      });

      await request(app).post("/api/auth/logout").send({});

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/logout",
        status: "422",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram for /logout", async () => {
      mockRevoke.mockResolvedValueOnce(undefined);

      await request(app)
        .post("/api/auth/logout")
        .send({ refreshToken: VALID_TOKEN });

      const metrics = await authEndpointDuration.get();
      const sample = metrics.values.find(
        (v) => v.labels.route === "/logout" && v.labels.method === "POST",
      );
      expect(sample).toBeDefined();
    });
  });

  // ── POST /wallet/logout ─────────────────────────────────────────────────

  describe("POST /api/auth/wallet/logout", () => {
    it("increments counter with status=204 on successful wallet logout", async () => {
      mockRevoke.mockResolvedValueOnce(undefined);

      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/wallet/logout",
        status: "204",
      });

      await request(app)
        .post("/api/auth/wallet/logout")
        .send({ refreshToken: VALID_TOKEN });

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/wallet/logout",
        status: "204",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=422 when refreshToken is missing", async () => {
      const before = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/wallet/logout",
        status: "422",
      });

      await request(app).post("/api/auth/wallet/logout").send({});

      const after = counterValue(authEndpointRequestsTotal, {
        method: "POST",
        route: "/wallet/logout",
        status: "422",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram for /wallet/logout", async () => {
      mockRevoke.mockResolvedValueOnce(undefined);

      await request(app)
        .post("/api/auth/wallet/logout")
        .send({ refreshToken: VALID_TOKEN });

      const metrics = await authEndpointDuration.get();
      const sample = metrics.values.find(
        (v) =>
          v.labels.route === "/wallet/logout" && v.labels.method === "POST",
      );
      expect(sample).toBeDefined();
    });
  });

  // ── Label structure ──────────────────────────────────────────────────────

  describe("histogram label structure", () => {
    it("includes method, route, and status labels on /challenge observations", async () => {
      mockCreateChallenge.mockResolvedValueOnce({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });

      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: VALID_STELLAR });

      const metrics = await authEndpointDuration.get();
      const sample = metrics.values.find(
        (v) => v.labels.route === "/challenge",
      );
      expect(sample).toBeDefined();
      expect(sample!.labels).toMatchObject({
        method: "POST",
        route: "/challenge",
        status: "201",
      });
    });
  });

  describe("counter label structure", () => {
    it("includes method, route, and status labels on /challenge observations", async () => {
      mockCreateChallenge.mockResolvedValueOnce({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });

      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: VALID_STELLAR });

      const metrics = await authEndpointRequestsTotal.get();
      const sample = metrics.values.find(
        (v) => v.labels.route === "/challenge",
      );
      expect(sample).toBeDefined();
      expect(sample!.labels).toHaveProperty("method", "POST");
      expect(sample!.labels).toHaveProperty("status", "201");
      expect(sample!.value).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Exposition format ────────────────────────────────────────────────────

  describe("Prometheus exposition format", () => {
    it("records /challenge requests in text exposition output", async () => {
      mockCreateChallenge.mockResolvedValueOnce({
        nonce: VALID_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      });

      await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: VALID_STELLAR });

      const res = await request(app).get("/api/metrics");
      expect(res.text).toContain(
        'auth_endpoint_requests_total{method="POST",route="/challenge",status="201"}',
      );
    });

    it("records /logout requests in text exposition output", async () => {
      mockRevoke.mockResolvedValueOnce(undefined);

      await request(app)
        .post("/api/auth/logout")
        .send({ refreshToken: VALID_TOKEN });

      const res = await request(app).get("/api/metrics");
      expect(res.text).toContain(
        'auth_endpoint_requests_total{method="POST",route="/logout",status="204"}',
      );
    });

    it("records /wallet/logout requests in text exposition output", async () => {
      mockRevoke.mockResolvedValueOnce(undefined);

      await request(app)
        .post("/api/auth/wallet/logout")
        .send({ refreshToken: VALID_TOKEN });

      const res = await request(app).get("/api/metrics");
      expect(res.text).toContain(
        'auth_endpoint_requests_total{method="POST",route="/wallet/logout",status="204"}',
      );
    });
  });
});
