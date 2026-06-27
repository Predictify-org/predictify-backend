import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminAuditRouter } from "../src/routes/admin/audit";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Mock Repository ─────────────────────────────────────────────────────────

jest.mock("../src/repositories/auditLogRepo");

import { getAuditLogs } from "../src/repositories/auditLogRepo";
const mockGetAuditLogs = getAuditLogs as jest.MockedFunction<typeof getAuditLogs>;

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

function makeApp(rateLimitPerMinute = 60): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/audit", createAdminAuditRouter({ rateLimitPerMinute }));
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
});
