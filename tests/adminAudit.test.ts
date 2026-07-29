import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminAuditRouter } from "../src/routes/admin/audit";
import { createAdminAuditExportRouter } from "../src/routes/admin/audit/export";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Mock Repository ─────────────────────────────────────────────────────────

jest.mock("../src/repositories/auditLogRepo");

import { getAuditLogs, getAuditLogsStream } from "../src/repositories/auditLogRepo";
const mockGetAuditLogs = getAuditLogs as jest.MockedFunction<typeof getAuditLogs>;
const mockGetAuditLogsStream = getAuditLogsStream as jest.MockedFunction<typeof getAuditLogsStream>;

// ── DB Mock (Prevents connection at import time) ─────────────────────────────

jest.mock("../src/db/client", () => ({ db: {} }));

// ── JWT Helpers ──────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS  = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt  = signJwt({ sub: USER_ADDRESS,  role: "user" });

// ── App Factory ──────────────────────────────────────────────────────────────

function makeApp(rateLimitPerMinute = 60, maxRecords = 100_000): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/audit", createAdminAuditRouter({ rateLimitPerMinute }));
  app.use("/api/admin/audit", createAdminAuditExportRouter({ rateLimitPerMinute, maxRecords }));
  app.use(errorHandler);
  return app;
}

// ── Test Suites ──────────────────────────────────────────────────────────────

describe("GET /api/admin/audit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("auth", () => {
    it("returns 403 with no Authorization header", async () => {
      const res = await request(makeApp()).get("/api/admin/audit");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 403 with a non-admin JWT (role: user)", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit")
        .set("Authorization", `Bearer ${userJwt}`);
      expect(res.status).toBe(403);
    });

    it("returns 403 with a JWT signed by a different secret", async () => {
      const badToken = jwt.sign(
        { sub: ADMIN_ADDRESS, role: "admin" },
        "wrong-secret-at-least-32-characters-long",
        { issuer: ISSUER, audience: AUDIENCE },
      );
      const res = await request(makeApp())
        .get("/api/admin/audit")
        .set("Authorization", `Bearer ${badToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("validation", () => {
    it("returns 400 for invalid limit format", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit?limit=-5")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for non-numeric limit", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit?limit=abc")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid date format (startDate)", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit?startDate=2024-01-01")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("startDate must be a valid ISO 8601 datetime string");
    });

    it("returns 400 for invalid date format (endDate)", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit?endDate=2024-13-45T25:00:00Z")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("endDate must be a valid ISO 8601 datetime string");
    });
  });

  describe("happy path & parameters mapping", () => {
    it("calls getAuditLogs with correct filter mappings", async () => {
      const mockResult = {
        data: [
          {
            id: "1",
            action: "market.create",
            walletAddress: ADMIN_ADDRESS,
            ip: "127.0.0.1",
            correlationId: "corr-1",
            rateLimitContext: null,
            createdAt: new Date("2026-06-27T12:00:00Z"),
          },
        ],
        nextCursor: null,
      };
      mockGetAuditLogs.mockResolvedValue(mockResult);

      const startDateStr = "2026-06-27T00:00:00.000Z";
      const endDateStr = "2026-06-27T23:59:59.000Z";

      const res = await request(makeApp())
        .get(`/api/admin/audit?action=market.create&actor=${ADMIN_ADDRESS}&startDate=${startDateStr}&endDate=${endDateStr}&limit=5&cursor=abc`)
        .set("Authorization", `Bearer ${adminJwt}`);

      expect(res.status).toBe(200);
      expect(mockGetAuditLogs).toHaveBeenCalledWith({
        action: "market.create",
        actor: ADMIN_ADDRESS,
        startDate: new Date(startDateStr),
        endDate: new Date(endDateStr),
        limit: 5,
        cursor: "abc",
      });
      expect(res.body).toEqual({
        data: [
          {
            id: "1",
            action: "market.create",
            walletAddress: ADMIN_ADDRESS,
            ip: "127.0.0.1",
            correlationId: "corr-1",
            rateLimitContext: null,
            createdAt: "2026-06-27T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    });
  });

  describe("POST /api/admin/audit/search", () => {
    it("returns 403 with no Authorization header", async () => {
      const res = await request(makeApp()).post("/api/admin/audit/search").send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 400 for invalid payload parameters", async () => {
      const res = await request(makeApp())
        .post("/api/admin/audit/search")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ limit: -5 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("limit must be a positive integer");
    });

    it("returns 400 for invalid date string format", async () => {
      const res = await request(makeApp())
        .post("/api/admin/audit/search")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ startDate: "invalid-date" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("startDate must be a valid ISO 8601 datetime string");
    });

    it("calls getAuditLogs with correct filter mappings via JSON body", async () => {
      const mockResult = {
        data: [
          {
            id: "2",
            action: "user.login",
            walletAddress: USER_ADDRESS,
            ip: "127.0.0.1",
            correlationId: "corr-2",
            rateLimitContext: null,
            createdAt: new Date("2026-06-27T12:00:00Z"),
          },
        ],
        nextCursor: "next-abc",
      };
      mockGetAuditLogs.mockResolvedValue(mockResult);

      const startDateStr = "2026-06-27T00:00:00.000Z";
      const endDateStr = "2026-06-27T23:59:59.000Z";

      const res = await request(makeApp())
        .post("/api/admin/audit/search")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({
          action: "user.login",
          actor: USER_ADDRESS,
          startDate: startDateStr,
          endDate: endDateStr,
          limit: 10,
          cursor: "abc",
        });

      expect(res.status).toBe(200);
      expect(mockGetAuditLogs).toHaveBeenCalledWith({
        action: "user.login",
        actor: USER_ADDRESS,
        startDate: new Date(startDateStr),
        endDate: new Date(endDateStr),
        limit: 10,
        cursor: "abc",
      });
      expect(res.body).toEqual({
        data: [
          {
            id: "2",
            action: "user.login",
            walletAddress: USER_ADDRESS,
            ip: "127.0.0.1",
            correlationId: "corr-2",
            rateLimitContext: null,
            createdAt: "2026-06-27T12:00:00.000Z",
          },
        ],
        nextCursor: "next-abc",
      });
    });
  });

  describe("GET /api/admin/audit/export", () => {
    it("returns 403 with no Authorization header", async () => {
      const res = await request(makeApp()).get("/api/admin/audit/export");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 403 with a non-admin JWT", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit/export")
        .set("Authorization", `Bearer ${userJwt}`);
      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid startDate format", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit/export?startDate=2024-01-01")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("startDate must be a valid ISO 8601 datetime string");
    });

    it("returns 400 for invalid endDate format", async () => {
      const res = await request(makeApp())
        .get("/api/admin/audit/export?endDate=2024-13-45T25:00:00Z")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("endDate must be a valid ISO 8601 datetime string");
    });

    it("streams audit records as NDJSON with correct headers", async () => {
      mockGetAuditLogsStream.mockImplementation(async function* () {
        yield {
          id: "1",
          action: "market.create",
          walletAddress: ADMIN_ADDRESS,
          ip: "127.0.0.1",
          correlationId: "corr-1",
          rateLimitContext: null,
          createdAt: new Date("2026-06-27T12:00:00Z"),
        };
      });

      const res = await request(makeApp())
        .get("/api/admin/audit/export?action=market.create&actor=" + ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${adminJwt}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/x-ndjson/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="audit-export-\d+\.ndjson"$/);
      expect(res.text).toBe(
        JSON.stringify({
          id: "1",
          action: "market.create",
          walletAddress: ADMIN_ADDRESS,
          ip: "127.0.0.1",
          correlationId: "corr-1",
          rateLimitContext: null,
          createdAt: new Date("2026-06-27T12:00:00Z"),
        }) + "\n",
      );
      expect(mockGetAuditLogsStream).toHaveBeenCalledWith({
        action: "market.create",
        actor: ADMIN_ADDRESS,
      });
    });

    it("enforces maxRecords and stops streaming after the limit", async () => {
      mockGetAuditLogsStream.mockImplementation(async function* () {
        yield {
          id: "1",
          action: "market.create",
          walletAddress: ADMIN_ADDRESS,
          ip: "127.0.0.1",
          correlationId: "corr-1",
          rateLimitContext: null,
          createdAt: new Date("2026-06-27T12:00:00Z"),
        };
        yield {
          id: "2",
          action: "market.update",
          walletAddress: ADMIN_ADDRESS,
          ip: "127.0.0.1",
          correlationId: "corr-2",
          rateLimitContext: null,
          createdAt: new Date("2026-06-27T12:30:00Z"),
        };
      });

      const res = await request(makeApp(60, 1))
        .get("/api/admin/audit/export")
        .set("Authorization", `Bearer ${adminJwt}`);

      expect(res.status).toBe(200);
      expect(res.text).toBe(
        JSON.stringify({
          id: "1",
          action: "market.create",
          walletAddress: ADMIN_ADDRESS,
          ip: "127.0.0.1",
          correlationId: "corr-1",
          rateLimitContext: null,
          createdAt: new Date("2026-06-27T12:00:00Z"),
        }) + "\n",
      );
    });
  });
});
