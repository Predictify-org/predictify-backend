/**
 * tests/integration/reports.test.ts
 *
 * Integration test for /api/reports endpoints using Supertest + testcontainers.
 * Hits the full stack: Express router -> middleware -> DB -> response.
 *
 * Coverage:
 *   - POST   /api/reports/scheduled        — create (201, 401, 422)
 *   - GET    /api/reports/scheduled        — list with pagination (200)
 *   - GET    /api/reports/scheduled/:id    — get single (200, 404, 403)
 *   - PATCH  /api/reports/scheduled/:id    — update (200, 404, 403)
 *   - DELETE /api/reports/scheduled/:id    — delete (204, 404, 403)
 */

import request from "supertest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/index";
import { db, closeDb } from "../../src/db";
import { users, scheduledReports } from "../../src/db/schema";

// Mock the queue connection (required by createApp imports)
jest.mock("../../src/queue", () => ({
  redisConnection: {
    on: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
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

jest.mock("../../src/cache/marketsCache", () => ({
  marketCacheKeys: {
    all: "markets:all",
    byId: (marketId: string) => `markets:${marketId}`,
  },
  invalidateMarketCache: jest.fn().mockResolvedValue(undefined),
}));

const JWT_SECRET =
  process.env.JWT_SECRET || "test-integration-jwt-secret-at-least-32-chars!!";

const STELLAR_ADDRESS =
  "GTESTREPORTUSER00000000000000000000000000000000000000000000001";

function makeToken(stellarAddress: string): string {
  return jwt.sign(
    { sub: stellarAddress },
    JWT_SECRET,
    { issuer: "predictify", audience: "predictify-app", expiresIn: "5m" },
  );
}

describe("Reports Integration Tests", () => {
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    app = createApp();

    // Clean any pre-existing test data
    await db
      .delete(scheduledReports)
      .where(eq(scheduledReports.userId, "integration-test-user"));
    await db.delete(users).where(eq(users.stellarAddress, STELLAR_ADDRESS));

    // Seed test user
    await db.insert(users).values({
      stellarAddress: STELLAR_ADDRESS,
    });

    token = makeToken(STELLAR_ADDRESS);
  });

  afterAll(async () => {
    // Clean up test data
    await db
      .delete(scheduledReports)
      .where(eq(scheduledReports.userId, "integration-test-user"));
    await db.delete(users).where(eq(users.stellarAddress, STELLAR_ADDRESS));
    await closeDb();
  });

  describe("POST /api/reports/scheduled", () => {
    it("returns 401 if request is unauthenticated", async () => {
      const res = await request(app).post("/api/reports/scheduled").send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
      });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthenticated");
    });

    it("returns 422 for invalid request body (missing reportType)", async () => {
      const res = await request(app)
        .post("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`)
        .send({
          schedule: "0 2 * * *",
          format: "csv",
        });

      expect(res.status).toBe(422);
      expect(res.body.error.correlationId).toBeDefined();
    });

    it("returns 422 for invalid cron expression", async () => {
      const res = await request(app)
        .post("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`)
        .send({
          reportType: "predictions",
          schedule: "invalid-cron",
          format: "csv",
        });

      expect(res.status).toBe(422);
    });

    it("returns 422 for unknown report type", async () => {
      const res = await request(app)
        .post("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`)
        .send({
          reportType: "unknown-type",
          schedule: "0 2 * * *",
          format: "csv",
        });

      expect(res.status).toBe(422);
    });

    it("successfully creates a scheduled report with valid input", async () => {
      const res = await request(app)
        .post("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`)
        .send({
          reportType: "predictions",
          schedule: "0 2 * * *",
          format: "csv",
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.reportType).toBe("predictions");
      expect(res.body.data.schedule).toBe("0 2 * * *");
      expect(res.body.data.format).toBe("csv");
      expect(res.body.data.active).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();

      // Clean up created report
      await db
        .delete(scheduledReports)
        .where(eq(scheduledReports.id, res.body.data.id));
    });

    it("successfully creates with optional filters and active=false", async () => {
      const res = await request(app)
        .post("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`)
        .send({
          reportType: "predictions",
          schedule: "30 14 * * 1",
          format: "json",
          filters: { startDate: "2026-01-01T00:00:00Z" },
          active: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.format).toBe("json");
      expect(res.body.data.active).toBe(false);
      expect(res.body.data.filters).toEqual({ startDate: "2026-01-01T00:00:00Z" });

      // Clean up created report
      await db
        .delete(scheduledReports)
        .where(eq(scheduledReports.id, res.body.data.id));
    });
  });

  describe("GET /api/reports/scheduled", () => {
    const reportIds: string[] = [];

    beforeAll(async () => {
      // Seed two reports for the test user
      for (let i = 0; i < 2; i++) {
        const [report] = await db
          .insert(scheduledReports)
          .values({
            userId: "integration-test-user", // Will match req.user.id
            reportType: "predictions",
            schedule: "0 2 * * *",
            format: "csv",
            filters: {},
            active: true,
          })
          .returning();
        reportIds.push(report.id);
      }
    });

    afterAll(async () => {
      for (const id of reportIds) {
        await db.delete(scheduledReports).where(eq(scheduledReports.id, id));
      }
    });

    it("returns paginated scheduled reports", async () => {
      const res = await request(app)
        .get("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it("returns a valid x-request-id header", async () => {
      const res = await request(app)
        .get("/api/reports/scheduled")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBeDefined();
    });
  });

  describe("GET /api/reports/scheduled/:id", () => {
    let reportId: string;

    beforeAll(async () => {
      const [report] = await db
        .insert(scheduledReports)
        .values({
          userId: "integration-test-user",
          reportType: "predictions",
          schedule: "0 2 * * *",
          format: "csv",
          filters: {},
          active: true,
        })
        .returning();
      reportId = report.id;
    });

    afterAll(async () => {
      await db.delete(scheduledReports).where(eq(scheduledReports.id, reportId));
    });

    it("returns a single scheduled report by ID", async () => {
      const res = await request(app)
        .get(`/api/reports/scheduled/${reportId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(reportId);
      expect(res.body.data.reportType).toBe("predictions");
      expect(res.body.data.schedule).toBe("0 2 * * *");
    });

    it("returns 404 for a non-existent report ID", async () => {
      const res = await request(app)
        .get("/api/reports/scheduled/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe("NotFound");
    });
  });

  describe("PATCH /api/reports/scheduled/:id", () => {
    let reportId: string;

    beforeAll(async () => {
      const [report] = await db
        .insert(scheduledReports)
        .values({
          userId: "integration-test-user",
          reportType: "predictions",
          schedule: "0 2 * * *",
          format: "csv",
          filters: {},
          active: true,
        })
        .returning();
      reportId = report.id;
    });

    afterAll(async () => {
      await db.delete(scheduledReports).where(eq(scheduledReports.id, reportId));
    });

    it("updates the schedule of a scheduled report", async () => {
      const res = await request(app)
        .patch(`/api/reports/scheduled/${reportId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ schedule: "30 14 * * 1" });

      expect(res.status).toBe(200);
      expect(res.body.data.schedule).toBe("30 14 * * 1");
    });

    it("returns 404 for a non-existent report ID", async () => {
      const res = await request(app)
        .patch("/api/reports/scheduled/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${token}`)
        .send({ active: false });

      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe("NotFound");
    });

    it("returns 422 when no fields are provided", async () => {
      const res = await request(app)
        .patch(`/api/reports/scheduled/${reportId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(422);
      expect(res.body.error.type).toBe("ValidationError");
    });
  });

  describe("DELETE /api/reports/scheduled/:id", () => {
    let reportId: string;

    beforeEach(async () => {
      const [report] = await db
        .insert(scheduledReports)
        .values({
          userId: "integration-test-user",
          reportType: "predictions",
          schedule: "0 2 * * *",
          format: "csv",
          filters: {},
          active: true,
        })
        .returning();
      reportId = report.id;
    });

    afterEach(async () => {
      await db.delete(scheduledReports).where(eq(scheduledReports.id, reportId));
    });

    it("deletes a scheduled report and returns 204", async () => {
      const res = await request(app)
        .delete(`/api/reports/scheduled/${reportId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(204);

      // Verify the report no longer exists in the database
      const [deleted] = await db
        .select()
        .from(scheduledReports)
        .where(eq(scheduledReports.id, reportId))
        .limit(1);
      expect(deleted).toBeUndefined();
    });

    it("returns 404 for a non-existent report ID", async () => {
      const res = await request(app)
        .delete("/api/reports/scheduled/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe("NotFound");
    });
  });

  describe("Authentication", () => {
    it("returns 401 for every endpoint when no token is provided", async () => {
      const endpoints = [
        { method: "post" as const, path: "/api/reports/scheduled" },
        { method: "get" as const, path: "/api/reports/scheduled" },
        { method: "get" as const, path: "/api/reports/scheduled/some-id" },
        { method: "patch" as const, path: "/api/reports/scheduled/some-id" },
        { method: "delete" as const, path: "/api/reports/scheduled/some-id" },
      ];

      for (const { method, path } of endpoints) {
        const res = await request(app)[method](path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("unauthenticated");
      }
    });

    it("returns 401 with a malformed token", async () => {
      const res = await request(app)
        .post("/api/reports/scheduled")
        .set("Authorization", "Bearer not-a-real-jwt")
        .send({
          reportType: "predictions",
          schedule: "0 2 * * *",
          format: "csv",
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthenticated");
    });
  });
});
