jest.mock("../src/db/client", () => ({ db: {} }));
jest.mock("../src/queue", () => ({
  redisConnection: { on: jest.fn() },
  webhookQueue: { add: jest.fn() },
  backupVerificationQueue: { add: jest.fn() },
  reconciliationQueue: { add: jest.fn() },
  marketResolutionQueue: { add: jest.fn() },
}));

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminFeatureFlagsRouter } from "../src/routes/admin/feature-flags";
import { resetFeatureFlagsForTests } from "../src/services/featureFlagService";
import { errorHandler } from "../src/middleware/errorHandler";

let createApp: typeof import("../src/index").createApp;

beforeAll(async () => {
  createApp = (await import("../src/index")).createApp;
});

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-at-least-32-chars!!";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: ADMIN_ADDRESS, role: "user" });

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/feature-flags", createAdminFeatureFlagsRouter());
  app.use(errorHandler);
  return app;
}

function auth(req: request.Test): request.Test {
  return req.set("Authorization", `Bearer ${adminJwt}`);
}

beforeEach(() => resetFeatureFlagsForTests());

describe("admin feature-flags CRUD", () => {
  it("rejects non-admin callers with 403", async () => {
    const res = await request(makeApp())
      .get("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it("is mounted in the application router", async () => {
    const app = createApp();
    const res = await auth(request(app).get("/api/admin/feature-flags"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("creates, reads, lists, updates and deletes a flag", async () => {
    const app = makeApp();

    const created = await auth(
      request(app).post("/api/admin/feature-flags").send({
        key: "new-dashboard",
        enabled: true,
        description: "Beta dashboard",
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ key: "new-dashboard", enabled: true });

    const got = await auth(request(app).get("/api/admin/feature-flags/new-dashboard"));
    expect(got.status).toBe(200);
    expect(got.body.data.description).toBe("Beta dashboard");

    const list = await auth(request(app).get("/api/admin/feature-flags"));
    expect(list.body.data).toHaveLength(1);

    const patched = await auth(
      request(app).patch("/api/admin/feature-flags/new-dashboard").send({ enabled: false }),
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data.enabled).toBe(false);

    const removed = await auth(request(app).delete("/api/admin/feature-flags/new-dashboard"));
    expect(removed.status).toBe(204);

    const missing = await auth(request(app).get("/api/admin/feature-flags/new-dashboard"));
    expect(missing.status).toBe(404);
  });

  it("returns 409 on duplicate key and 400 on invalid body", async () => {
    const app = makeApp();
    await auth(request(app).post("/api/admin/feature-flags").send({ key: "dup", enabled: true }));

    const dup = await auth(
      request(app).post("/api/admin/feature-flags").send({ key: "dup", enabled: false }),
    );
    expect(dup.status).toBe(409);

    const bad = await auth(
      request(app).post("/api/admin/feature-flags").send({ key: "bad key!", enabled: true }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_error");
  });
});
