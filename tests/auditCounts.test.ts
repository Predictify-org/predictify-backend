import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAuditCountsRouter } from "../src/routes/audit/counts";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Mock Repository ─────────────────────────────────────────────────────────

jest.mock("../src/repositories/auditLogRepo");

import { getAuditCounts } from "../src/repositories/auditLogRepo";
const mockGetAuditCounts = getAuditCounts as jest.MockedFunction<typeof getAuditCounts>;

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
  app.use("/api/audit/counts", createAuditCountsRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

// ── Test Suites ──────────────────────────────────────────────────────────────

describe("GET /api/audit/counts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("auth", () => {
    it("returns 403 with no Authorization header", async () => {
      const res = await request(makeApp()).get("/api/audit/counts");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 403 with a non-admin JWT (role: user)", async () => {
      const res = await request(makeApp())
        .get("/api/audit/counts")
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
        .get("/api/audit/counts")
        .set("Authorization", `Bearer ${badToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("validation", () => {
    it("returns 400 for invalid startDate format", async () => {
      const res = await request(makeApp())
        .get("/api/audit/counts?startDate=2024-01-01")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("startDate must be a valid ISO 8601 datetime string");
    });

    it("returns 400 for invalid endDate format", async () => {
      const res = await request(makeApp())
        .get("/api/audit/counts?endDate=2024-13-45T25:00:00Z")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("endDate must be a valid ISO 8601 datetime string");
    });
  });

  describe("happy path & parameters mapping", () => {
    it("calls getAuditCounts with correct filter mappings and returns the summary", async () => {
      const mockResult = {
        totalCount: 3,
        byAction: [
          { action: "market.create", count: 2 },
          { action: "user.login", count: 1 },
        ],
      };
      mockGetAuditCounts.mockResolvedValue(mockResult);

      const startDateStr = "2026-06-27T00:00:00.000Z";
      const endDateStr = "2026-06-27T23:59:59.000Z";

      const res = await request(makeApp())
        .get(`/api/audit/counts?startDate=${startDateStr}&endDate=${endDateStr}`)
        .set("Authorization", `Bearer ${adminJwt}`);

      expect(res.status).toBe(200);
      expect(mockGetAuditCounts).toHaveBeenCalledWith({
        startDate: new Date(startDateStr),
        endDate: new Date(endDateStr),
      });
      expect(res.body).toEqual({ data: mockResult });
    });

    it("supports no filters (full summary)", async () => {
      const mockResult = { totalCount: 0, byAction: [] };
      mockGetAuditCounts.mockResolvedValue(mockResult);

      const res = await request(makeApp())
        .get("/api/audit/counts")
        .set("Authorization", `Bearer ${adminJwt}`);

      expect(res.status).toBe(200);
      expect(mockGetAuditCounts).toHaveBeenCalledWith({});
      expect(res.body).toEqual({ data: mockResult });
    });
  });

  describe("rate limiting", () => {
    it("returns 429 once the per-minute limit is exceeded", async () => {
      mockGetAuditCounts.mockResolvedValue({ totalCount: 0, byAction: [] });
      const app = makeApp(1);

      const first = await request(app)
        .get("/api/audit/counts")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(first.status).toBe(200);

      const second = await request(app)
        .get("/api/audit/counts")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(second.status).toBe(429);
    });
  });
});
