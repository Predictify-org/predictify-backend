import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../../src/index";
import { closeDb } from "../../src/db/client";
import { resetFeatureFlagsForTests } from "../../src/services/featureFlagService";

jest.mock("../../src/queue", () => ({
  redisConnection: {
    on: jest.fn(),
    quit: jest.fn(),
  },
  webhookQueueName: "webhook-deliveries",
  backupVerificationQueueName: "backup-verification",
  reconciliationQueueName: "reconciliation",
  marketResolutionQueueName: "market-resolution",
  webhookQueue: {},
  backupVerificationQueue: {},
  reconciliationQueue: {},
  marketResolutionQueue: {},
}));

const SECRET = "test-integration-jwt-secret-at-least-32-chars!!";
const ISSUER = "predictify";
const AUDIENCE = "predictify-app";

const ADMIN_ADDRESS = "GADMIN9999999999999999999999999999999999999999999999999999";
const USER_ADDRESS = "GUSER11111111111111111111111111111111111111111111111111111";

function signJwt(payload: Record<string, unknown>): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDRESS, role: "user" });

describe("POST /api/admin/feature-flags", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    resetFeatureFlagsForTests();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns 403 when no Authorization header is sent", async () => {
    const res = await request(app).get("/api/admin/feature-flags");
    expect(res.status).toBe(403);
  });

  it("returns 403 when a non-admin JWT is provided", async () => {
    const res = await request(app)
      .get("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it("creates a feature flag and returns 201 with the created resource", async () => {
    const res = await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "new-checkout", enabled: true, description: "New checkout flow" });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      key: "new-checkout",
      enabled: true,
      description: "New checkout flow",
    });
    expect(res.body.data.updatedAt).toBeDefined();
  });

  it("lists feature flags", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "flag-a", enabled: true });

    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "flag-b", enabled: false });

    const res = await request(app)
      .get("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it("gets a single feature flag by key", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "dark-mode", enabled: true });

    const res = await request(app)
      .get("/api/admin/feature-flags/dark-mode")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe("dark-mode");
    expect(res.body.data.enabled).toBe(true);
  });

  it("returns 404 when getting a non-existent flag", async () => {
    const res = await request(app)
      .get("/api/admin/feature-flags/does-not-exist")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(404);
  });

  it("updates a feature flag via PATCH", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "toggle-me", enabled: false });

    const res = await request(app)
      .patch("/api/admin/feature-flags/toggle-me")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
  });

  it("returns 404 when updating a non-existent flag", async () => {
    const res = await request(app)
      .patch("/api/admin/feature-flags/ghost")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("deletes a feature flag and returns 204", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "temp-flag", enabled: false });

    const del = await request(app)
      .delete("/api/admin/feature-flags/temp-flag")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(del.status).toBe(204);

    const get = await request(app)
      .get("/api/admin/feature-flags/temp-flag")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(get.status).toBe(404);
  });

  it("returns 404 when deleting a non-existent flag", async () => {
    const res = await request(app)
      .delete("/api/admin/feature-flags/nope")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(404);
  });

  it("returns 409 when creating a duplicate flag key", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "dup-key", enabled: true });

    const res = await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "dup-key", enabled: false });

    expect(res.status).toBe(409);
  });

  it("returns 400 when the key is missing", async () => {
    const res = await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ enabled: true });

    expect(res.status).toBe(400);
  });

  it("returns 400 when enabled is missing", async () => {
    const res = await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "no-enabled" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when key contains invalid characters", async () => {
    const res = await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "has spaces!", enabled: true });

    expect(res.status).toBe(400);
  });

  it("returns 400 when PATCH body is empty", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "patch-test", enabled: true });

    const res = await request(app)
      .patch("/api/admin/feature-flags/patch-test")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("propagates x-correlation-id through the response", async () => {
    const correlationId = "test-corr-id-ff-001";

    const res = await request(app)
      .get("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("x-correlation-id", correlationId);

    expect(res.status).toBe(200);
    expect(res.headers["x-correlation-id"]).toBeDefined();
  });

  it("propagates x-request-id through the response", async () => {
    const res = await request(app)
      .get("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("full CRUD lifecycle: create, read, update, delete", async () => {
    const create = await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "lifecycle", enabled: false, description: "lifecycle test" });

    expect(create.status).toBe(201);
    expect(create.body.data.key).toBe("lifecycle");
    expect(create.body.data.enabled).toBe(false);

    const read = await request(app)
      .get("/api/admin/feature-flags/lifecycle")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(read.status).toBe(200);
    expect(read.body.data.description).toBe("lifecycle test");

    const update = await request(app)
      .patch("/api/admin/feature-flags/lifecycle")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ enabled: true, description: "updated" });

    expect(update.status).toBe(200);
    expect(update.body.data.enabled).toBe(true);
    expect(update.body.data.description).toBe("updated");

    const del = await request(app)
      .delete("/api/admin/feature-flags/lifecycle")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(del.status).toBe(204);

    const gone = await request(app)
      .get("/api/admin/feature-flags/lifecycle")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(gone.status).toBe(404);
  });

  it("allows updating only the description without touching enabled", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "desc-only", enabled: true });

    const res = await request(app)
      .patch("/api/admin/feature-flags/desc-only")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ description: "new description" });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.description).toBe("new description");
  });

  it("allows setting description to null", async () => {
    await request(app)
      .post("/api/admin/feature-flags")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ key: "null-desc", enabled: true, description: "has desc" });

    const res = await request(app)
      .patch("/api/admin/feature-flags/null-desc")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ description: null });

    expect(res.status).toBe(200);
    expect(res.body.data.description).toBeNull();
  });
});
