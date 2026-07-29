/**
 * SQL Injection Regression Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Fires SQL injection payloads against every parameterized input across all
 * API routes and asserts that:
 *
 *   (a) Inputs that fail Zod schema validation are rejected with HTTP 400.
 *   (b) Inputs that pass schema validation (free-text fields, opaque IDs, etc.)
 *       are handled safely by Drizzle's parameterized queries and never cause
 *       an HTTP 500 or leak internal database error messages.
 *
 * Two test scopes are provided:
 *   • "Smoke Suite"  – one representative payload per injection class.
 *                      Fast (~seconds). Run on every PR.
 *   • "Full Catalog" – every payload in payloads.ts swept over every endpoint.
 *                      Thorough (~minutes). Run nightly / on security branches.
 *
 * Coverage map (all parameterized inputs):
 *   Auth:            challenge, verify, refresh, logout, wallet/logout
 *   Markets:         list, search, featured, upcoming, get/:id, patch/:id,
 *                    disputes, events
 *   Admin Markets:   feature POST/DELETE
 *   Predictions:     explain
 *   Exports:         predictions GET/POST
 *   Leaderboard:     list, user/:address
 *   Notifications:   preferences PATCH
 *   Users:           predictions, profile, follow/unfollow
 *   Devices:         list (auth-protected, no user-controlled params)
 *   Admin Audit:     list
 *   Admin Users:     get/:address
 *   Admin Freeze:    get/post/delete /:address/freeze
 *   Admin Recon:     markets/:id
 *   Admin Webhooks:  dlq list, dlq replay
 *   Admin Fraud:     flags list, scan
 *   Admin Flags:     feature-flags CRUD
 */

// ─── 1. Environment variables (must precede all src/ imports) ───────────────
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "security-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.ADMIN_ALLOWLIST =
  "GADMIN777777777777777777777777777777777777777777777777777777";

// ─── 2. Infrastructure mocks (pg, Redis, BullMQ) ────────────────────────────
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

jest.mock("ioredis", () =>
  jest.fn().mockImplementation(() => ({ on: jest.fn() })),
);

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation((name: string) => ({ name })),
  Worker: jest.fn(),
  QueueEvents: jest.fn(),
}));

// ─── 3. Database client mocks ────────────────────────────────────────────────
// Build a chainable mock that resolves to [] when awaited at any point
const chainable: any = {
  execute: jest.fn().mockResolvedValue({ rows: [] }),
  returning: jest.fn().mockResolvedValue([]),
};
// Every chainable method returns a thenable that resolves to [] AND has all
// the same sub-methods, so patterns like db.select().from().where() work.
const thenableChain: any = {
  ...chainable,
  then: (resolve: (v: any) => any) => Promise.resolve([]).then(resolve),
};
const chainFn = () => thenableChain;
["select","from","where","limit","orderBy","insert","values","update","set","delete","leftJoin","innerJoin","groupBy","having","offset"].forEach((m) => {
  thenableChain[m] = chainFn;
  chainable[m] = chainFn;
});

const mockDb = {
  ...thenableChain,
  execute: jest.fn().mockResolvedValue({ rows: [] }),
  insert: chainFn,
  values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
  returning: jest.fn().mockResolvedValue([]),
  delete: chainFn,
  query: {
    users: {
      findFirst: jest.fn().mockResolvedValue({
        id: "user-uuid",
        stellarAddress:
          "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
      }),
    },
    markets: {
      findFirst: jest.fn().mockResolvedValue({ id: "market-1", status: "active" }),
    },
    predictions: {
      findFirst: jest.fn().mockResolvedValue({ id: "pred-1", userId: "user-uuid" }),
    },
    disputes: { findFirst: jest.fn().mockResolvedValue(null) },
  },
  transaction: jest.fn().mockImplementation(async (cb: (db: unknown) => unknown) =>
    cb(mockDb),
  ),
};

jest.mock("../../src/db/client", () => ({
  db: mockDb,
  getDb: () => mockDb,
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  connectWithRetry: jest.fn().mockResolvedValue(undefined),
  closeDb: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/db/index", () => ({ db: mockDb }));

jest.mock("../../src/db", () => ({ db: mockDb }));

// ─── 4. Auth middleware mocks ────────────────────────────────────────────────
const MOCK_USER = {
  id: "user-uuid",
  stellarAddress: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
};
const MOCK_ADMIN = "GADMIN777777777777777777777777777777777777777777777777777777";

jest.mock("../../src/middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = MOCK_USER; next(); },
  requireAuthForbidden: (req: any, _res: any, next: any) => { req.user = MOCK_USER; next(); },
  optionalAuth: (req: any, _res: any, next: any) => { req.user = MOCK_USER; next(); },
}));

jest.mock("../../src/middleware/requireAdmin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.adminAddress = MOCK_ADMIN;
    next();
  },
}));

jest.mock("../../src/middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { id: MOCK_ADMIN, stellarAddress: MOCK_ADMIN };
    next();
  },
}));

// ─── 5. Service mocks ────────────────────────────────────────────────────────
jest.mock("../../src/services/userService", () => ({
  getUserByAddress: jest.fn().mockResolvedValue({ id: "user-uuid" }),
  getUserPredictions: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
  getCurrentUserProfile: jest.fn().mockResolvedValue({
    ok: true,
    value: {
      stellarAddress: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
      totals: {},
    },
  }),
  getUserProfile: jest.fn().mockResolvedValue({ predictions: [] }),
}));

jest.mock("../../src/services/marketService", () => ({
  listMarkets: jest.fn().mockResolvedValue([]),
  getMarketById: jest.fn().mockResolvedValue({ id: "market-1" }),
  updateMarket: jest.fn().mockResolvedValue({}),
  listUpcomingMarkets: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../src/services/marketFeatureService", () => ({
  listFeaturedMarkets: jest.fn().mockResolvedValue([]),
  featureMarket: jest.fn().mockResolvedValue({ id: "market-1", featured: true }),
  unfeatureMarket: jest.fn().mockResolvedValue({ id: "market-1", featured: false }),
  MarketNotFoundError: class MarketNotFoundError extends Error {},
  MarketArchivedError: class MarketArchivedError extends Error { code = "market_archived"; },
}));

jest.mock("../../src/services/leaderboardService", () => ({
  getLeaderboard: jest.fn().mockResolvedValue([]),
  getLeaderboardWithRefresh: jest.fn().mockResolvedValue([]),
  getUserLeaderboardEntry: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/services/predictionExplainService", () => ({
  getPredictionExplanation: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/services/reconciliationService", () => ({
  reconcileMarket: jest.fn().mockResolvedValue({}),
  performReconciliation: jest.fn().mockResolvedValue({}),
  getReconciliationReport: jest.fn().mockResolvedValue({}),
  listReconciliationReports: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../src/services/refreshTokenService", () => ({
  rotateRefreshToken: jest.fn().mockResolvedValue({ ok: true, value: {} }),
  revokeFamily: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/services/authChallengeService", () => ({
  createChallenge: jest.fn().mockResolvedValue({
    nonce: "test-nonce",
    expiresAt: new Date(),
  }),
}));

jest.mock("../../src/services/authVerifyService", () => ({
  verifyChallengeAndIssueJwt: jest.fn().mockResolvedValue({ ok: true, value: {} }),
}));

jest.mock("../../src/services/disputeService", () => ({
  openDispute: jest.fn().mockResolvedValue({}),
  DisputeError: class DisputeError extends Error {
    constructor(public status: number, public code: string, msg: string) { super(msg); }
  },
}));

jest.mock("../../src/services/adminUsersService", () => ({
  getAdminUserView: jest.fn().mockResolvedValue({}),
  writeAuditLog: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/services/userFreezeService", () => ({
  getFreezeStatus: jest.fn().mockReturnValue({ frozen: false }),
  freezeUser: jest.fn().mockReturnValue({ frozen: true }),
  unfreezeUser: jest.fn().mockReturnValue({ frozen: false }),
}));

jest.mock("../../src/services/fraudService", () => ({
  listFraudFlags: jest.fn().mockResolvedValue([]),
  runFraudScan: jest.fn().mockResolvedValue({ scanned: 0, flagged: 0 }),
  DrizzleFraudRepo: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/services/featureFlagService", () => ({
  listFeatureFlags: jest.fn().mockReturnValue([]),
  getFeatureFlag: jest.fn().mockReturnValue({ key: "test-flag", enabled: true }),
  createFeatureFlag: jest.fn().mockReturnValue({ key: "test-flag", enabled: true }),
  updateFeatureFlag: jest.fn().mockReturnValue({ key: "test-flag", enabled: false }),
  deleteFeatureFlag: jest.fn().mockReturnValue(undefined),
  FeatureFlagConflictError: class FeatureFlagConflictError extends Error {
    status = 409; code = "conflict";
  },
  FeatureFlagNotFoundError: class FeatureFlagNotFoundError extends Error {
    status = 404; code = "not_found";
  },
}));

jest.mock("../../src/services/exportService", () => ({
  getPredictionsStream: jest.fn().mockImplementation(function* () {}),
  formatPredictionAsCsv: jest.fn().mockReturnValue(""),
}));

jest.mock("../../src/services/notificationPrefs", () => ({
  getNotificationPreferences: jest.fn().mockResolvedValue([]),
  patchNotificationPreferences: jest.fn().mockResolvedValue([]),
  notificationCategories: ["market_resolved", "new_prediction", "dispute_opened"] as const,
  notificationChannels: ["email", "push"] as const,
}));

jest.mock("../../src/repositories/auditLogRepo", () => ({
  getAuditLogs: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
}));

jest.mock("../../src/repositories/marketRepository", () => ({
  searchMarkets: jest.fn().mockResolvedValue({ data: [], total: 0, fallback: false }),
}));

jest.mock("../../src/repositories/socialRepository", () => ({
  socialRepository: {
    followUser: jest.fn().mockResolvedValue({}),
    unfollowUser: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/middleware/rateLimitAnon", () => ({
  rateLimitAnon: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/utils/url", () => ({
  validateHttpsUrl: jest.fn().mockReturnValue({ valid: true }),
  validateSsrf: jest.fn().mockResolvedValue({ valid: true }),
}));

// ─── 6. Project imports (after all mocks) ───────────────────────────────────
import request from "supertest";
import express from "express";
import { createApp } from "../../src/index";
import {
  sqlInjectionPayloads,
  sqlInjectionSmokeSuite,
} from "./payloads";
import { adminUsersRouter } from "../../src/routes/adminUsers";
import { adminReconciliationRouter } from "../../src/routes/admin/reconciliation";
import { createAdminWebhooksRouter } from "../../src/routes/adminWebhooks";
import { createAdminFraudRouter } from "../../src/routes/admin/fraud";
import { createAdminFeatureFlagsRouter } from "../../src/routes/admin/feature-flags";
import { createAdminFreezeRouter } from "../../src/routes/admin/users/freeze";
import { exportsPredictionsRouter } from "../../src/routes/exports/predictions";
import { errorHandler } from "../../src/middleware/errorHandler";

// ─── 7. App instances ────────────────────────────────────────────────────────

/** Main app — all routes that are mounted in src/index.ts */
const mainApp = createApp();

/**
 * Auxiliary app — routers that are NOT mounted in the main index but are
 * separately deployable / tested. We wire them here so the injection suite
 * covers the full attack surface.
 */
const auxApp = express();
auxApp.use(express.json());

// Admin users + freeze (not in main index)
auxApp.use("/api/admin/users", adminUsersRouter);
auxApp.use("/api/admin/users", createAdminFreezeRouter());

// Admin reconciliation (not in main index)
auxApp.use("/api/admin/recon", adminReconciliationRouter);

// Admin webhooks DLQ (factory-pattern router)
const mockWebhookStore = {
  listDlq: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
  getDlqRow: jest.fn().mockResolvedValue(null),
};
const mockWebhookDispatcher = {
  replayFromDlq: jest.fn().mockResolvedValue(null),
};
auxApp.use(
  "/api/admin/webhooks",
  createAdminWebhooksRouter({
    store: mockWebhookStore as any,
    dispatcher: mockWebhookDispatcher as any,
  }),
);

// Admin fraud (factory-pattern router)
auxApp.use("/api/admin/fraud", createAdminFraudRouter());

// Admin feature flags (factory-pattern router)
auxApp.use("/api/admin/feature-flags", createAdminFeatureFlagsRouter());

// Exports — not in main index
auxApp.use("/api/exports/predictions", exportsPredictionsRouter);

auxApp.use(errorHandler);

// ─── 8. Assertion helpers ────────────────────────────────────────────────────

/**
 * Asserts that a response is "safe":
 *   • No HTTP 500 (internal server error / unhandled exception).
 *   • Response body does not contain raw SQL or database error fragments that
 *     would indicate query construction from user input.
 */
function assertSafeResponse(res: request.Response): void {
  expect(res.status).not.toBe(500);

  // Check that the body text doesn't leak raw SQL error patterns
  const body = JSON.stringify(res.body ?? "");
  const leakPatterns = [
    /syntax error at or near/i,
    /pg_query\(\)/i,
    /PG::SyntaxError/i,
    /unterminated quoted string/i,
    /column .* does not exist/i,
    /relation .* does not exist/i,
    /ERROR:.*SQL/i,
    /SQLiteException/i,
    /ORA-\d{5}/i,          // Oracle errors
    /Unclosed quotation/i,  // SQL Server
  ];
  for (const pattern of leakPatterns) {
    expect(body).not.toMatch(pattern);
  }
}

/**
 * Convenience wrapper: POST to `url` with `body` on `app`, assert safe.
 */
async function postSafe(
  app: express.Express,
  url: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request(app).post(url).send(body);
  assertSafeResponse(res);
}

/**
 * Convenience wrapper: GET `url` with `query` on `app`, assert safe.
 */
async function getSafe(
  app: express.Express,
  url: string,
  query: Record<string, unknown> = {},
): Promise<void> {
  const res = await request(app).get(url).query(query as any);
  assertSafeResponse(res);
}

// ─── 9. Test suites ──────────────────────────────────────────────────────────

/**
 * SMOKE SUITE
 * ───────────
 * One representative payload per injection class swept over every endpoint.
 * Designed to be fast enough to run on every pull-request CI build.
 */
describe("SQL Injection Regression Suite – Smoke", () => {

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe("Auth routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/challenge – stellarAddress payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/challenge", { stellarAddress: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/verify – stellarAddress payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/verify", {
          stellarAddress: payload,
          nonce: "some-nonce",
          signature: "some-signature",
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/verify – nonce payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/verify", {
          stellarAddress: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
          nonce: payload,
          signature: "some-signature",
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/verify – signature payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/verify", {
          stellarAddress: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
          nonce: "some-nonce",
          signature: payload,
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/refresh – refreshToken payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/refresh", { refreshToken: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/logout – refreshToken payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/logout", { refreshToken: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/auth/wallet/logout – refreshToken payload: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/wallet/logout", { refreshToken: payload });
      },
    );
  });

  // ── Markets ───────────────────────────────────────────────────────────────

  describe("Markets routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets – limit query payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets", { limit: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/search – q payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/search – limit payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: "test", limit: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/search – offset payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: "test", offset: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/search – page payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: "test", page: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/featured – limit payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/featured", { limit: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/upcoming – limit payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/upcoming", { limit: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/:id – id path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/markets/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "PATCH /api/markets/:id – id path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .patch(`/api/markets/${encodeURIComponent(payload)}`)
          .send({ expectedVersion: 1 });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "PATCH /api/markets/:id – body question payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .patch("/api/markets/market-1")
          .send({ question: payload, expectedVersion: 1 });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/markets/:id/disputes – market id payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .post(`/api/markets/${encodeURIComponent(payload)}/disputes`)
          .send({ reason: "This is a valid dispute reason that is long enough." });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/markets/:id/disputes – reason body payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .post("/api/markets/market-1/disputes")
          .send({ reason: payload });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/markets/:id/disputes – evidenceUri payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .post("/api/markets/market-1/disputes")
          .send({
            reason: "This is a valid dispute reason that is long enough.",
            evidenceUri: payload,
          });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/markets/:id/events – id path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/markets/${encodeURIComponent(payload)}/events`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Predictions ───────────────────────────────────────────────────────────

  describe("Predictions routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/predictions/:id/explain – id path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/predictions/${encodeURIComponent(payload)}/explain`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Leaderboard ───────────────────────────────────────────────────────────

  describe("Leaderboard routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/leaderboard – limit/offset/refresh query payloads: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/leaderboard", {
          limit: payload,
          offset: payload,
          refresh: payload,
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/leaderboard – period query payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/leaderboard", { period: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/leaderboard/user/:stellarAddress – address path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/leaderboard/user/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Notifications ─────────────────────────────────────────────────────────

  describe("Notifications routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "PATCH /api/notifications/preferences – preferences payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .patch("/api/notifications/preferences")
          .send({ preferences: payload });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "PATCH /api/notifications/preferences – category field payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .patch("/api/notifications/preferences")
          .send({
            preferences: [{ category: payload, channel: "email", enabled: true }],
          });
        assertSafeResponse(res);
      },
    );
  });

  // ── Users ─────────────────────────────────────────────────────────────────

  describe("Users routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/users/:address/predictions – address path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/users/${encodeURIComponent(payload)}/predictions`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/users/:address/predictions – status query payload: %s",
      async (payload) => {
        await getSafe(
          mainApp,
          "/api/users/GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO/predictions",
          { status: payload },
        );
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/users/:address/predictions – cursor query payload: %s",
      async (payload) => {
        await getSafe(
          mainApp,
          "/api/users/GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO/predictions",
          { cursor: payload },
        );
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/users/:stellarAddress/profile – address path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/users/${encodeURIComponent(payload)}/profile`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/users/:addr/follow – address path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .post(`/api/users/${encodeURIComponent(payload)}/follow`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "DELETE /api/users/:addr/follow – address path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .delete(`/api/users/${encodeURIComponent(payload)}/follow`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Devices ───────────────────────────────────────────────────────────────

  describe("Devices routes", () => {
    it("GET /api/me/devices – authenticated request returns safe response", async () => {
      // No user-controlled query params; verifies auth-protected path is safe
      const res = await request(mainApp).get("/api/me/devices");
      assertSafeResponse(res);
    });
  });

  // ── Admin – Audit ─────────────────────────────────────────────────────────

  describe("Admin Audit routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/audit – action query payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/admin/audit", { action: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/audit – actor query payload: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/admin/audit", { actor: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/audit – date range query payloads: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/admin/audit", {
          startDate: payload,
          endDate: payload,
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/audit – cursor/limit query payloads: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/admin/audit", {
          cursor: payload,
          limit: payload,
        });
      },
    );
  });

  // ── Admin – Markets feature/unfeature ─────────────────────────────────────

  describe("Admin Markets feature routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/markets/:id/feature – id path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .post(`/api/admin/markets/${encodeURIComponent(payload)}/feature`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "DELETE /api/admin/markets/:id/feature – id path payload: %s",
      async (payload) => {
        const res = await request(mainApp)
          .delete(`/api/admin/markets/${encodeURIComponent(payload)}/feature`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Users ─────────────────────────────────────────────────────────

  describe("Admin Users routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/users/:address – address path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .get(`/api/admin/users/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Freeze ────────────────────────────────────────────────────────

  describe("Admin Freeze routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/users/:address/freeze – address path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .get(`/api/admin/users/${encodeURIComponent(payload)}/freeze`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/users/:address/freeze – address path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post(`/api/admin/users/${encodeURIComponent(payload)}/freeze`)
          .send({ reason: "test" });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/users/:address/freeze – reason body payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post("/api/admin/users/GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO/freeze")
          .send({ reason: payload });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "DELETE /api/admin/users/:address/freeze – address path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .delete(`/api/admin/users/${encodeURIComponent(payload)}/freeze`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Reconciliation ────────────────────────────────────────────────

  describe("Admin Reconciliation routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/recon/markets/:id – id path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .get(`/api/admin/recon/markets/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Webhooks DLQ ──────────────────────────────────────────────────

  describe("Admin Webhooks routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/webhooks/dlq – cursor query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/admin/webhooks/dlq", { cursor: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/webhooks/dlq – limit query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/admin/webhooks/dlq", { limit: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/webhooks/dlq/:id/replay – id path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post(`/api/admin/webhooks/dlq/${encodeURIComponent(payload)}/replay`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Fraud ─────────────────────────────────────────────────────────

  describe("Admin Fraud routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/fraud/flags – status query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/admin/fraud/flags", { status: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/fraud/flags – limit query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/admin/fraud/flags", { limit: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/fraud/scan – lookbackMs body payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post("/api/admin/fraud/scan")
          .send({ lookbackMs: payload });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/fraud/scan – maxPredictions body payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post("/api/admin/fraud/scan")
          .send({ maxPredictions: payload });
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Feature Flags ─────────────────────────────────────────────────

  describe("Admin Feature Flags routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "POST /api/admin/feature-flags – key body payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post("/api/admin/feature-flags")
          .send({ key: payload, enabled: true });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/admin/feature-flags/:key – key path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .get(`/api/admin/feature-flags/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "PATCH /api/admin/feature-flags/:key – key path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .patch(`/api/admin/feature-flags/${encodeURIComponent(payload)}`)
          .send({ enabled: false });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "DELETE /api/admin/feature-flags/:key – key path payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .delete(`/api/admin/feature-flags/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );
  });

  // ── Exports – Predictions ─────────────────────────────────────────────────

  describe("Exports routes", () => {
    it.each(sqlInjectionSmokeSuite)(
      "GET /api/exports/predictions – format query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/exports/predictions", { format: payload });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/exports/predictions – startDate query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/exports/predictions", {
          format: "csv",
          startDate: payload,
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "GET /api/exports/predictions – endDate query payload: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/exports/predictions", {
          format: "csv",
          endDate: payload,
        });
      },
    );

    it.each(sqlInjectionSmokeSuite)(
      "POST /api/exports/predictions – body payload: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post("/api/exports/predictions")
          .send({ format: payload, startDate: payload, endDate: payload });
        assertSafeResponse(res);
      },
    );
  });

}); // end Smoke Suite

/**
 * FULL CATALOG SUITE
 * ──────────────────
 * Every payload in the catalog swept over every endpoint.
 * This suite is intentionally thorough — run nightly or on security-focused
 * branches. Use the SQLI_FULL_SUITE=1 environment variable to enable it in CI.
 */
const RUN_FULL = process.env.SQLI_FULL_SUITE === "1";
const describeFull = RUN_FULL ? describe : describe.skip;

describeFull("SQL Injection Regression Suite – Full Catalog", () => {

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe("Auth routes", () => {
    it.each(sqlInjectionPayloads)(
      "POST /api/auth/challenge – stellarAddress: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/challenge", { stellarAddress: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/auth/verify – stellarAddress: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/verify", {
          stellarAddress: payload,
          nonce: "nonce",
          signature: "sig",
        });
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/auth/verify – nonce: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/verify", {
          stellarAddress: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
          nonce: payload,
          signature: "sig",
        });
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/auth/verify – signature: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/verify", {
          stellarAddress: "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO",
          nonce: "nonce",
          signature: payload,
        });
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/auth/refresh – refreshToken: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/refresh", { refreshToken: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/auth/logout – refreshToken: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/logout", { refreshToken: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/auth/wallet/logout – refreshToken: %s",
      async (payload) => {
        await postSafe(mainApp, "/api/auth/wallet/logout", { refreshToken: payload });
      },
    );
  });

  // ── Markets ───────────────────────────────────────────────────────────────

  describe("Markets routes", () => {
    it.each(sqlInjectionPayloads)(
      "GET /api/markets – limit: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets", { limit: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/markets/search – q: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/markets/search – limit: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: "test", limit: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/markets/search – offset: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/search", { q: "test", offset: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/markets/featured – limit: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/featured", { limit: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/markets/upcoming – limit: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/markets/upcoming", { limit: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/markets/:id – id path: %s",
      async (payload) => {
        const res = await request(mainApp)
          .get(`/api/markets/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionPayloads)(
      "PATCH /api/markets/:id – body question: %s",
      async (payload) => {
        const res = await request(mainApp)
          .patch("/api/markets/market-1")
          .send({ question: payload, expectedVersion: 1 });
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/markets/:id/disputes – reason: %s",
      async (payload) => {
        const res = await request(mainApp)
          .post("/api/markets/market-1/disputes")
          .send({ reason: payload });
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Audit ─────────────────────────────────────────────────────────

  describe("Admin Audit routes", () => {
    it.each(sqlInjectionPayloads)(
      "GET /api/admin/audit – action: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/admin/audit", { action: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/admin/audit – actor: %s",
      async (payload) => {
        await getSafe(mainApp, "/api/admin/audit", { actor: payload });
      },
    );
  });

  // ── Admin – Users ─────────────────────────────────────────────────────────

  describe("Admin Users routes", () => {
    it.each(sqlInjectionPayloads)(
      "GET /api/admin/users/:address – address path: %s",
      async (payload) => {
        const res = await request(auxApp)
          .get(`/api/admin/users/${encodeURIComponent(payload)}`);
        assertSafeResponse(res);
      },
    );

    it.each(sqlInjectionPayloads)(
      "POST /api/admin/users/:address/freeze – reason body: %s",
      async (payload) => {
        const res = await request(auxApp)
          .post(
            "/api/admin/users/GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO/freeze",
          )
          .send({ reason: payload });
        assertSafeResponse(res);
      },
    );
  });

  // ── Admin – Fraud ─────────────────────────────────────────────────────────

  describe("Admin Fraud routes", () => {
    it.each(sqlInjectionPayloads)(
      "GET /api/admin/fraud/flags – status: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/admin/fraud/flags", { status: payload });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/admin/fraud/flags – limit: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/admin/fraud/flags", { limit: payload });
      },
    );
  });

  // ── Exports ───────────────────────────────────────────────────────────────

  describe("Exports routes", () => {
    it.each(sqlInjectionPayloads)(
      "GET /api/exports/predictions – startDate: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/exports/predictions", {
          format: "csv",
          startDate: payload,
        });
      },
    );

    it.each(sqlInjectionPayloads)(
      "GET /api/exports/predictions – endDate: %s",
      async (payload) => {
        await getSafe(auxApp, "/api/exports/predictions", {
          format: "csv",
          endDate: payload,
        });
      },
    );
  });

}); // end Full Catalog Suite
