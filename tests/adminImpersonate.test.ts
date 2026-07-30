import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminImpersonateRouter } from "../src/routes/admin/users/impersonate";
import { errorHandler } from "../src/middleware/errorHandler";

jest.mock("../src/services/jwtService");
jest.mock("../src/services/auditService");
jest.mock("../src/db/client", () => ({ db: { insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue({}) }) } }));

import { signAccessToken, verifyAccessToken } from "../src/services/jwtService";
import { createAuditLog } from "../src/services/auditService";

const mockSignAccessToken = signAccessToken as jest.MockedFunction<typeof signAccessToken>;
const mockVerifyAccessToken = verifyAccessToken as jest.MockedFunction<typeof verifyAccessToken>;
const mockCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

const SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-that-is-at-least-32-chars!";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDRESS, role: "user" });

function makeApp(rateLimitPerMinute = 60): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/users", createAdminImpersonateRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

describe("POST /api/admin/users/:address/impersonate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyAccessToken.mockImplementation((token: string) => {
      const decoded = jwt.decode(token) as any;
      if (!decoded) throw new Error("invalid token");
      return decoded;
    });
  });

  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).post(`/api/admin/users/${USER_ADDRESS}/impersonate`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("sets API security headers on rejected impersonation requests", async () => {
    const res = await request(makeApp()).post(`/api/admin/users/${USER_ADDRESS}/impersonate`).send({});

    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("returns 403 with a non-admin JWT", async () => {
    const res = await request(makeApp())
      .post(`/api/admin/users/${USER_ADDRESS}/impersonate`)
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 400 for empty address", async () => {
    const res = await request(makeApp())
      .post("/api/admin/users/ /impersonate")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 200 and a token on successful impersonation", async () => {
    mockSignAccessToken.mockReturnValue("mocked-token-123");

    const res = await request(makeApp())
      .post(`/api/admin/users/${USER_ADDRESS}/impersonate`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe("mocked-token-123");

    expect(mockSignAccessToken).toHaveBeenCalledWith({ sub: USER_ADDRESS, role: "user" });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.impersonate",
        walletAddress: ADMIN_ADDRESS,
        beforeState: null,
        afterState: { targetAddress: USER_ADDRESS, role: "user" },
      })
    );
  });
});
