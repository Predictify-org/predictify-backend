import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/index";
import { db, closeDb } from "../../src/db/client";
import { auditLogs } from "../../src/db/schema";

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

describe("Integration Test: /api/health", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    app = createApp();
  });

  beforeEach(async () => {
    // Clean up auditLogs prior to each test run for isolated test state
    await db.delete(auditLogs).where(eq(auditLogs.action, "health.state_mutation"));
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(eq(auditLogs.action, "health.state_mutation"));
    await closeDb();
  });

  describe("GET /api/health", () => {
    it("returns 200 with default health state when no audit log mutations exist", async () => {
      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "ok");
      expect(res.body).toHaveProperty("state");
      expect(res.body.state).toEqual({
        mode: "active",
        maintenance: false,
      });
    });

    it("includes request and correlation tracking headers in the response", async () => {
      const customCorrelationId = "test-corr-id-health-12345";
      const res = await request(app)
        .get("/api/health")
        .set("x-correlation-id", customCorrelationId);

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.headers["x-correlation-id"]).toBe(customCorrelationId);
    });

    it("returns latest mutated health state from database", async () => {
      // First mutate the health state
      await request(app)
        .post("/api/health/mutations")
        .send({ mode: "maintenance", maintenance: true });

      // Fetch health state
      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.state).toEqual({
        mode: "maintenance",
        maintenance: true,
      });
    });
  });

  describe("POST /api/health/mutations", () => {
    it("updates health state and persists audit log in database end-to-end", async () => {
      const mutationPayload = {
        mode: "degraded",
        maintenance: false,
        reason: "Scheduled DB maintenance",
      };

      const res = await request(app)
        .post("/api/health/mutations")
        .send(mutationPayload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("updated");
      expect(res.body.state).toMatchObject({
        mode: "degraded",
        maintenance: false,
        reason: "Scheduled DB maintenance",
      });

      // Verify DB persistence end-to-end
      const logs = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "health.state_mutation"));

      expect(logs.length).toBeGreaterThan(0);
      const latest = logs[logs.length - 1];
      expect(latest.action).toBe("health.state_mutation");
      expect(latest.afterState).toMatchObject(mutationPayload);
    });

    it("merges sequential state mutations on top of previous state", async () => {
      // First mutation
      await request(app)
        .post("/api/health/mutations")
        .send({ mode: "read_only", maintenance: true, notice: "Read-only mode active" });

      // Second mutation (partial override)
      const res = await request(app)
        .post("/api/health/mutations")
        .send({ maintenance: false });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("updated");
      expect(res.body.state).toEqual({
        mode: "read_only",
        maintenance: false,
        notice: "Read-only mode active",
      });
    });
  });
});
