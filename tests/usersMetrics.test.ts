/**
 * Tests for per-endpoint Prometheus metrics on /api/users.
 *
 * Verifies that `usersEndpointRequestsTotal` (Counter) and
 * `usersEndpointDuration` (Histogram) are incremented/observed for each
 * route handler in src/routes/users.ts.
 *
 * Strategy: mount `usersRouter` directly on a small Express app (same pattern
 * as usersMe.test.ts) with mocked deps so we exercise only the route + metrics
 * wiring.
 */

// ---------------------------------------------------------------------------
// 1. Env vars (must run BEFORE project imports)
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "users-metrics-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mock pg so requireAuthForbidden cannot open a real socket.
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
// 4. Mock the userService so we control all service returns.
// ---------------------------------------------------------------------------
jest.mock("../src/services/userService", () => ({
  __esModule: true,
  getCurrentUserProfile: jest.fn(),
  getUserByAddress: jest.fn(),
  getUserPredictions: jest.fn(),
  getUserProfile: jest.fn(),
}));

// ---------------------------------------------------------------------------
// 5. Project imports (safe now — env is set, mocks are in place).
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { usersRouter } from "../src/routes/users";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  getCurrentUserProfile,
  getUserByAddress,
  getUserPredictions,
  getUserProfile,
} from "../src/services/userService";
import {
  usersEndpointRequestsTotal,
  usersEndpointDuration,
} from "../src/metrics/registry";

const mockGetCurrentUserProfile =
  getCurrentUserProfile as jest.MockedFunction<typeof getCurrentUserProfile>;
const mockGetUserByAddress =
  getUserByAddress as jest.MockedFunction<typeof getUserByAddress>;
const mockGetUserPredictions =
  getUserPredictions as jest.MockedFunction<typeof getUserPredictions>;
const mockGetUserProfile =
  getUserProfile as jest.MockedFunction<typeof getUserProfile>;

// ---------------------------------------------------------------------------
// App factory
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
/** Valid 56-char Stellar address (G + 55 base32 chars [A-Z2-7]). */
const TEST_STELLAR = "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCE";

function signToken(sub: string = TEST_STELLAR): string {
  return jwt.sign({ sub }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
  });
}

function mockDbReturnsUser(): void {
  authLimit.mockResolvedValueOnce([
    { id: TEST_USER_ID, stellarAddress: TEST_STELLAR },
  ]);
}

/**
 * Read the current value (.value) for a given label set from the counter's
 * internal hashMap.
 */
function counterValue(
  counter: typeof usersEndpointRequestsTotal,
  labels: Record<string, string>,
): number {
  const key = Object.keys(labels)
    .sort()
    .map((k) => `${k}:${labels[k]}`)
    .join(",") + ",";
  const entry = counter.hashMap[key] as { value: number } | undefined;
  return entry?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Per-endpoint metrics on /api/users", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authSelect.mockImplementation(() => ({ from: authFrom } as any));
    authFrom.mockImplementation(() => ({ where: authWhere } as any));
    authWhere.mockImplementation(() => ({ limit: authLimit } as any));
  });

  // ── GET /api/users/me ─────────────────────────────────────────────────

  describe("GET /api/users/me", () => {
    it("increments counter with method, route, and status labels", async () => {
      mockDbReturnsUser();
      mockGetCurrentUserProfile.mockResolvedValueOnce({
        ok: true as const,
        value: {
          stellarAddress: TEST_STELLAR,
          createdAt: "2024-01-01T00:00:00.000Z",
          totals: { prediction_count: 0, claim_count: 0 },
        },
      });

      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/me",
        status: "200",
      });

      await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${signToken()}`);

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/me",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      mockDbReturnsUser();
      mockGetCurrentUserProfile.mockResolvedValueOnce({
        ok: true as const,
        value: {
          stellarAddress: TEST_STELLAR,
          createdAt: "2024-01-01T00:00:00.000Z",
          totals: { prediction_count: 0, claim_count: 0 },
        },
      });

      const res = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${signToken()}`);

      expect(res.status).toBe(200);
      const metrics = await usersEndpointDuration.get();
      const routeMetric = metrics.values.find(
        (v) => v.labels.route === "/me" && v.labels.method === "GET",
      );
      expect(routeMetric).toBeDefined();
    });

    it("records status=403 for unauthenticated requests", async () => {
      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/me",
        status: "403",
      });

      await request(app).get("/api/users/me");

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/me",
        status: "403",
      });
      expect(after).toBe(before + 1);
    });
  });

  // ── GET /api/users/:address/predictions ───────────────────────────────

  describe("GET /api/users/:address/predictions", () => {
    it("increments counter for successful request", async () => {
      const userRow = { id: TEST_USER_ID, stellarAddress: TEST_STELLAR };
      mockGetUserByAddress.mockResolvedValueOnce(userRow as any);
      mockGetUserPredictions.mockResolvedValueOnce({
        data: [{ id: "p1", marketId: "m1", outcome: "yes" }],
        nextCursor: null,
      });

      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:address/predictions",
        status: "200",
      });

      await request(app).get(
        `/api/users/${TEST_STELLAR}/predictions?limit=10`,
      );

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:address/predictions",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("records 400 for invalid Stellar address", async () => {
      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:address/predictions",
        status: "400",
      });

      await request(app).get("/api/users/not-a-valid-address/predictions");

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:address/predictions",
        status: "400",
      });
      expect(after).toBe(before + 1);
    });

    it("records 404 when user not found", async () => {
      mockGetUserByAddress.mockResolvedValueOnce(null);

      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:address/predictions",
        status: "404",
      });

      await request(app).get(
        `/api/users/${TEST_STELLAR}/predictions?limit=10`,
      );

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:address/predictions",
        status: "404",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      const userRow = { id: TEST_USER_ID, stellarAddress: TEST_STELLAR };
      mockGetUserByAddress.mockResolvedValueOnce(userRow as any);
      mockGetUserPredictions.mockResolvedValueOnce({
        data: [],
        nextCursor: null,
      });

      const res = await request(app).get(
        `/api/users/${TEST_STELLAR}/predictions?limit=10`,
      );

      expect(res.status).toBe(200);
      const metrics = await usersEndpointDuration.get();
      const routeMetric = metrics.values.find(
        (v) =>
          v.labels.route === "/:address/predictions" &&
          v.labels.method === "GET",
      );
      expect(routeMetric).toBeDefined();
    });
  });

  // ── GET /api/users/:stellarAddress/profile ────────────────────────────

  describe("GET /api/users/:stellarAddress/profile", () => {
    it("increments counter for successful profile request", async () => {
      mockGetUserProfile.mockResolvedValueOnce({
        stellarAddress: TEST_STELLAR,
        predictions: [],
      } as any);

      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:stellarAddress/profile",
        status: "200",
      });

      await request(app).get(
        `/api/users/${TEST_STELLAR}/profile`,
      );

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:stellarAddress/profile",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("records 422 for invalid Stellar address (validation via RouteError)", async () => {
      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:stellarAddress/profile",
        status: "422",
      });

      await request(app).get("/api/users/not-valid/profile");

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:stellarAddress/profile",
        status: "422",
      });
      expect(after).toBe(before + 1);
    });

    it("records 404 when profile not found", async () => {
      mockGetUserProfile.mockResolvedValueOnce(null);

      const before = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:stellarAddress/profile",
        status: "404",
      });

      await request(app).get(
        `/api/users/${TEST_STELLAR}/profile`,
      );

      const after = counterValue(usersEndpointRequestsTotal, {
        method: "GET",
        route: "/:stellarAddress/profile",
        status: "404",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      mockGetUserProfile.mockResolvedValueOnce({
        stellarAddress: TEST_STELLAR,
        predictions: [],
      } as any);

      const res = await request(app).get(
        `/api/users/${TEST_STELLAR}/profile`,
      );

      expect(res.status).toBe(200);
      const metrics = await usersEndpointDuration.get();
      const routeMetric = metrics.values.find(
        (v) =>
          v.labels.route === "/:stellarAddress/profile" &&
          v.labels.method === "GET",
      );
      expect(routeMetric).toBeDefined();
    });
  });

  // ── Label structure ───────────────────────────────────────────────────

  describe("histogram label structure", () => {
    it("includes method, route, and status labels", async () => {
      mockDbReturnsUser();
      mockGetCurrentUserProfile.mockResolvedValueOnce({
        ok: true as const,
        value: {
          stellarAddress: TEST_STELLAR,
          createdAt: "2024-01-01T00:00:00.000Z",
          totals: { prediction_count: 0, claim_count: 0 },
        },
      });

      await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${signToken()}`);

      const metrics = await usersEndpointDuration.get();
      const meMetric = metrics.values.find(
        (v) => v.labels.route === "/me",
      );
      expect(meMetric).toBeDefined();
      expect(meMetric!.labels).toHaveProperty("method", "GET");
      expect(meMetric!.labels).toHaveProperty("status", "200");
    });
  });

  describe("counter label structure", () => {
    it("includes method, route, and status labels", async () => {
      mockDbReturnsUser();
      mockGetCurrentUserProfile.mockResolvedValueOnce({
        ok: true as const,
        value: {
          stellarAddress: TEST_STELLAR,
          createdAt: "2024-01-01T00:00:00.000Z",
          totals: { prediction_count: 0, claim_count: 0 },
        },
      });

      await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${signToken()}`);

      const metrics = await usersEndpointRequestsTotal.get();
      const meMetric = metrics.values.find(
        (v) => v.labels.route === "/me",
      );
      expect(meMetric).toBeDefined();
      expect(meMetric!.labels).toHaveProperty("method", "GET");
      expect(meMetric!.labels).toHaveProperty("status", "200");
      expect(meMetric!.value).toBeGreaterThanOrEqual(1);
    });
  });
});
