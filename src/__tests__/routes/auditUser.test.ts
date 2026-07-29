/**
 * Tests for GET /api/audit/user/:addr
 *
 * All DB and logger dependencies are mocked so no real Postgres connection
 * is required.  Auth is tested via a mock of requireAuth.
 */

import express from "express";
import request from "supertest";
import { createUserAuditRouter } from "../../routes/audit/user";
import { errorHandler } from "../../middleware/errorHandler";

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock("../../config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the repo — each test can override the resolved value.
jest.mock("../../repositories/auditLogRepo");
import { getAuditLogsByUser } from "../../repositories/auditLogRepo";
const mockGetAuditLogsByUser = getAuditLogsByUser as jest.MockedFunction<
  typeof getAuditLogsByUser
>;

// Mock requireAuth so we can inject any user shape without real JWTs.
jest.mock("../../middleware/requireAuth");
import { requireAuth } from "../../middleware/requireAuth";
const mockRequireAuth = requireAuth as jest.MockedFunction<typeof requireAuth>;

// Mock correlation middleware — keeps correlationId stable in tests.
jest.mock("../../middleware/correlation", () => ({
  ...jest.requireActual("../../middleware/correlation"),
  getCorrelationId: () => "test-correlation-id",
  correlationMiddleware: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

// A syntactically valid Stellar public key (G + 55 uppercase base-32 chars).
const OWNER_ADDR = "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF";
const OTHER_ADDR = "GBSM6GFMXVHPMPQCFXZXZXYKNB7VZAQM7GM5XJPQEXHVZXL7ZXVB7AAA";

const SAMPLE_LOG_ITEM = {
  id: "11111111-1111-1111-1111-111111111111",
  action: "auth.login",
  walletAddress: OWNER_ADDR,
  ip: "127.0.0.1",
  correlationId: "test-correlation-id",
  rateLimitContext: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const EMPTY_PAGE = { data: [], nextCursor: null };
const ONE_ITEM_PAGE = { data: [SAMPLE_LOG_ITEM], nextCursor: null };

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Builds a minimal Express app with the user audit router and error handler.
 * `user` is injected into req.user by the requireAuth mock.
 */
function buildApp(user: {
  id: string;
  stellarAddress: string;
  role?: string;
}) {
  // requireAuth mock: just populate req.user and call next()
  mockRequireAuth.mockImplementation((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = user;
    next();
  });

  const app = express();
  app.use("/api/audit/user", createUserAuditRouter({ rateLimitPerMinute: 100 }));
  app.use(errorHandler);
  return app;
}

// ── Test suites ────────────────────────────────────────────────────────────────

describe("GET /api/audit/user/:addr", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: return an empty page
    mockGetAuditLogsByUser.mockResolvedValue(EMPTY_PAGE);
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("returns 200 with an empty page when no logs exist", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], nextCursor: null });
    });

    it("returns log entries belonging to the user", async () => {
      mockGetAuditLogsByUser.mockResolvedValue(ONE_ITEM_PAGE);
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].action).toBe("auth.login");
    });

    it("forwards limit, cursor, action, startDate, endDate to the repo", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?limit=5&action=auth.login&startDate=2026-01-01T00:00:00.000Z&endDate=2026-12-31T23:59:59.000Z`,
      );

      expect(mockGetAuditLogsByUser).toHaveBeenCalledWith(
        OWNER_ADDR,
        expect.objectContaining({
          limit: 5,
          action: "auth.login",
          startDate: new Date("2026-01-01T00:00:00.000Z"),
          endDate: new Date("2026-12-31T23:59:59.000Z"),
        }),
      );
    });

    it("returns the nextCursor from the repo in the response body", async () => {
      mockGetAuditLogsByUser.mockResolvedValue({
        data: [SAMPLE_LOG_ITEM],
        nextCursor: "opaque-cursor-xyz",
      });
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.body.nextCursor).toBe("opaque-cursor-xyz");
    });

    it("forwards a cursor parameter to the repo", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?cursor=some-opaque-cursor`,
      );

      expect(mockGetAuditLogsByUser).toHaveBeenCalledWith(
        OWNER_ADDR,
        expect.objectContaining({ cursor: "some-opaque-cursor" }),
      );
    });
  });

  // ── Address validation ────────────────────────────────────────────────────────

  describe("address validation", () => {
    it("returns 400 for an address that doesn't start with G", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        "/api/audit/user/XAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("returns 400 for an address that is too short", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get("/api/audit/user/GSHORT");

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("returns 400 for an address containing lowercase letters", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const lowercase = OWNER_ADDR.toLowerCase();
      const res = await request(app).get(`/api/audit/user/${lowercase}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("returns 400 for an address containing special characters", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        "/api/audit/user/G!HK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("accepts a valid 56-character Stellar address", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      // Passes address validation (auth already passed too) → 200
      expect(res.status).toBe(200);
    });
  });

  // ── Query parameter validation ────────────────────────────────────────────────

  describe("query parameter validation", () => {
    it("returns 422 for a non-numeric limit", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?limit=abc`,
      );

      expect(res.status).toBe(422);
    });

    it("returns 422 for an invalid startDate", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?startDate=not-a-date`,
      );

      expect(res.status).toBe(422);
    });

    it("returns 422 for an invalid endDate", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?endDate=not-a-date`,
      );

      expect(res.status).toBe(422);
    });

    it("returns 422 for unknown query parameters (strict schema)", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?unknownParam=value`,
      );

      expect(res.status).toBe(422);
    });

    it("accepts limit=1", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?limit=1`,
      );

      expect(res.status).toBe(200);
    });

    it("accepts limit=100 (max)", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(
        `/api/audit/user/${OWNER_ADDR}?limit=100`,
      );

      expect(res.status).toBe(200);
    });
  });

  // ── Authorisation ─────────────────────────────────────────────────────────────

  describe("authorisation", () => {
    it("returns 403 when a non-admin requests another user's address", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OTHER_ADDR}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(mockGetAuditLogsByUser).not.toHaveBeenCalled();
    });

    it("returns 200 when a user requests their own address", async () => {
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.status).toBe(200);
    });

    it("returns 200 when an admin requests another user's address", async () => {
      const app = buildApp({
        id: "admin1",
        stellarAddress: OWNER_ADDR,
        role: "admin",
      });
      const res = await request(app).get(`/api/audit/user/${OTHER_ADDR}`);

      expect(res.status).toBe(200);
      expect(mockGetAuditLogsByUser).toHaveBeenCalledWith(
        OTHER_ADDR,
        expect.any(Object),
      );
    });

    it("returns 401 when requireAuth rejects the request", async () => {
      mockRequireAuth.mockImplementation((_req, res, _next) => {
        res.status(401).json({ error: { code: "unauthenticated" } });
      });

      const app = express();
      app.use(
        "/api/audit/user",
        createUserAuditRouter({ rateLimitPerMinute: 100 }),
      );
      app.use(errorHandler);

      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.status).toBe(401);
      expect(mockGetAuditLogsByUser).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 when the repository throws an unexpected error", async () => {
      mockGetAuditLogsByUser.mockRejectedValue(new Error("DB connection lost"));
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.status).toBe(500);
    });

    it("includes an error body for 500 responses", async () => {
      mockGetAuditLogsByUser.mockRejectedValue(new Error("DB connection lost"));
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      const res = await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── Structured logging ────────────────────────────────────────────────────────

  describe("structured logging", () => {
    it("logs a user_audit_fetch event on a successful request", async () => {
      const { logger } = jest.requireMock("../../config/logger") as {
        logger: { info: jest.Mock };
      };
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      const logCall = logger.info.mock.calls.find(
        (args: unknown[]) =>
          typeof args[1] === "string" && args[1] === "user_audit_fetch",
      );
      expect(logCall).toBeDefined();
    });

    it("includes correlationId in the fetch log", async () => {
      const { logger } = jest.requireMock("../../config/logger") as {
        logger: { info: jest.Mock };
      };
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      await request(app).get(`/api/audit/user/${OWNER_ADDR}`);

      const logCall = logger.info.mock.calls.find(
        (args: unknown[]) =>
          typeof args[1] === "string" && args[1] === "user_audit_fetch",
      );
      expect(logCall?.[0]).toHaveProperty("correlationId");
    });

    it("logs a user_audit_forbidden warning when a non-admin requests another address", async () => {
      const { logger } = jest.requireMock("../../config/logger") as {
        logger: { warn: jest.Mock };
      };
      const app = buildApp({ id: "u1", stellarAddress: OWNER_ADDR });
      await request(app).get(`/api/audit/user/${OTHER_ADDR}`);

      const warnCall = logger.warn.mock.calls.find(
        (args: unknown[]) =>
          typeof args[1] === "string" && args[1] === "user_audit_forbidden",
      );
      expect(warnCall).toBeDefined();
    });
  });
});
