import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminCircuitBreakerRouter, resetCircuitBreakersForTests } from "../src/routes/admin/circuit-breaker";
import { errorHandler } from "../src/middleware/errorHandler";

// Prevent a real DB connection at import time.
jest.mock("../src/db/client", () => ({ db: {} }));

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-at-least-32-chars!!";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";
const ADMIN_ADDR = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR = "GUSER00000000000000000000000000000000000000000000000000000";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminToken = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userToken = signJwt({ sub: USER_ADDR, role: "user" });

function makeApp(rateLimitPerMinute = 100): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/circuit-breaker", createAdminCircuitBreakerRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

function auth(req: request.Test, token: string): request.Test {
  return req.set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  resetCircuitBreakersForTests();
});

describe("admin circuit-breaker", () => {
  describe("GET /api/admin/circuit-breaker", () => {
    it("rejects non-admin callers with 403", async () => {
      const res = await request(makeApp())
        .get("/api/admin/circuit-breaker")
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects requests with no Authorization header", async () => {
      const res = await request(makeApp()).get("/api/admin/circuit-breaker");
      expect(res.status).toBe(403);
    });

    it("returns both breakers with default state (disabled)", async () => {
      const res = await request(makeApp())
        .get("/api/admin/circuit-breaker")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.map((b: any) => b.type).sort()).toEqual(["indexer", "webhook"]);
      expect(res.body.data.every((b: any) => b.enabled === false)).toBe(true);
      expect(res.body.data.every((b: any) => b.updatedBy === "system")).toBe(true);
    });
  });

  describe("PATCH /api/admin/circuit-breaker/:type", () => {
    it("rejects non-admin callers with 403", async () => {
      const res = await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ enabled: true });
      expect(res.status).toBe(403);
    });

    it("rejects invalid breaker type with 400", async () => {
      const res = await request(makeApp())
        .patch("/api/admin/circuit-breaker/invalid")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects invalid body with 400", async () => {
      const res = await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: "not-a-boolean" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("toggles indexer breaker to enabled", async () => {
      const res = await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        type: "indexer",
        enabled: true,
        updatedBy: ADMIN_ADDR,
      });
      expect(res.body.data.updatedAt).toBeTruthy();
    });

    it("toggles webhook breaker to enabled", async () => {
      const res = await request(makeApp())
        .patch("/api/admin/circuit-breaker/webhook")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        type: "webhook",
        enabled: true,
        updatedBy: ADMIN_ADDR,
      });
    });

    it("disables a previously enabled breaker", async () => {
      // First enable
      await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });

      // Then disable
      const res = await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.updatedBy).toBe(ADMIN_ADDR);
    });

    it("updates updatedAt timestamp on each toggle", async () => {
      const res1 = await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });

      // Small delay to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 10));

      const res2 = await request(makeApp())
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: false });

      expect(new Date(res2.body.data.updatedAt).getTime()).toBeGreaterThan(
        new Date(res1.body.data.updatedAt).getTime(),
      );
    });

    it("returns 429 when rate limit is breached", async () => {
      const app = makeApp(1); // 1 request/min
      const agent = request.agent(app);

      // First request should pass
      await agent
        .patch("/api/admin/circuit-breaker/indexer")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });

      // Second request within same window should be throttled
      const res = await agent
        .patch("/api/admin/circuit-breaker/webhook")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ enabled: true });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("rate_limit_exceeded");
    });
  });

  describe("integration: toggle then list", () => {
    it("lists updated state after toggle", async () => {
      const app = makeApp();

      // Enable indexer
      await auth(request(app).patch("/api/admin/circuit-breaker/indexer"), adminToken)
        .send({ enabled: true })
        .expect(200);

      // List and verify
      const listRes = await auth(request(app).get("/api/admin/circuit-breaker"), adminToken);
      expect(listRes.status).toBe(200);
      const indexer = listRes.body.data.find((b: any) => b.type === "indexer");
      expect(indexer.enabled).toBe(true);
      expect(indexer.updatedBy).toBe(ADMIN_ADDR);
    });
  });
});