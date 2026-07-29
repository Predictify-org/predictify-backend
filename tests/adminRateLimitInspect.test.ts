import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  adminRateLimitInspectStore,
  createAdminRateLimitInspectRouter,
} from "../src/routes/admin/rate-limit/inspect";
import { requestContextStorage } from "../src/lib/requestContext";

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDR = "GADMIN0000000000000000000000000000000000000000000000000000";
const USER_ADDR = "GUSER00000000000000000000000000000000000000000000000000000";
const TARGET_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function sign(payload: object): string {
  return jwt.sign(payload, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

const adminToken = sign({ sub: ADMIN_ADDR, role: "admin" });
const userToken = sign({ sub: USER_ADDR, role: "user" });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "test-req-id" }, next);
  });
  app.use(
    "/api/admin/rate-limit",
    createAdminRateLimitInspectRouter({
      windowMs: 60_000,
      max: 5,
      store: adminRateLimitInspectStore,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("GET /api/admin/rate-limit/inspect/:address", () => {
  beforeEach(() => {
    adminRateLimitInspectStore.clear();
  });

  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).get(`/api/admin/rate-limit/inspect/${TARGET_ADDR}`);

    expect(res.status).toBe(403);
  });

  it("returns 403 for a non-admin JWT", async () => {
    const res = await request(makeApp())
      .get(`/api/admin/rate-limit/inspect/${TARGET_ADDR}`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const res = await request(makeApp())
      .get("/api/admin/rate-limit/inspect/not-an-address")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns the current inspection state for a valid admin request", async () => {
    const now = Date.now();
    adminRateLimitInspectStore.record(TARGET_ADDR, now, 60_000);
    adminRateLimitInspectStore.record(TARGET_ADDR, now + 1000, 60_000);

    const res = await request(makeApp())
      .get(`/api/admin/rate-limit/inspect/${TARGET_ADDR}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: {
        address: TARGET_ADDR,
        limit: 5,
        used: 2,
        remaining: 3,
        windowMs: 60000,
      },
    });
    expect(typeof res.body.data.resetAt).toBe("string");
  });
});
