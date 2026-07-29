import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { rateLimitRouter } from "../src/routes/rate-limit";
import { requestContextStorage } from "../src/lib/requestContext";

jest.mock("../src/repositories/auditLogRepo");

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getAuditLogs } from "../src/repositories/auditLogRepo";

const mockGetAuditLogs = getAuditLogs as jest.MockedFunction<typeof getAuditLogs>;

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";
const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDRESS, role: "user" });

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "test-req-id" }, next);
  });
  app.use("/api/rate-limit", rateLimitRouter);
  return app;
}

describe("GET /api/rate-limit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 for non-admin callers", async () => {
    const res = await request(makeApp())
      .get("/api/rate-limit")
      .set("Authorization", `Bearer ${userJwt}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 400 for malformed pagination input", async () => {
    const res = await request(makeApp())
      .get("/api/rate-limit?cursor=&limit=-5")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("cursor must not be empty when provided");
  });

  it("returns cursor-paginated rate-limit events for admin callers", async () => {
    const mockResult = {
      data: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          action: "rate_limit.blocked",
          walletAddress: null,
          ip: "127.0.0.1",
          correlationId: "req-1",
          rateLimitContext: {
            limit: 60,
            remaining: 0,
            resetAt: "2026-07-24T12:00:00.000Z",
            blocked: true,
          },
          createdAt: new Date("2026-07-24T12:00:00.000Z"),
        },
      ],
      nextCursor: "next-cursor-token",
    };

    mockGetAuditLogs.mockResolvedValue(mockResult);

    const res = await request(makeApp())
      .get("/api/rate-limit?cursor=abc&limit=2")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(mockGetAuditLogs).toHaveBeenCalledWith({
      action: "rate_limit.blocked",
      cursor: "abc",
      limit: 2,
    });
    expect(res.body).toEqual({
      data: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          action: "rate_limit.blocked",
          walletAddress: null,
          ip: "127.0.0.1",
          correlationId: "req-1",
          rateLimitContext: {
            limit: 60,
            remaining: 0,
            resetAt: "2026-07-24T12:00:00.000Z",
            blocked: true,
          },
          createdAt: "2026-07-24T12:00:00.000Z",
        },
      ],
      nextCursor: "next-cursor-token",
    });
  });
});
