import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { closeDb, pool } from "../../src/db/client";
import { closeAuthPool } from "../../src/middleware/requireAuth";
import { signAccessToken } from "../../src/services/jwtService";
import { requestContextStorage } from "../../src/lib/requestContext";
import { errorHandler } from "../../src/middleware/errorHandler";

jest.mock("../../src/queue", () => ({
  redisConnection: {
    status: "ready",
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

jest.mock("../../src/cache/marketsCache", () => ({
  marketCacheKeys: {
    all: "markets:all",
    byId: (marketId: string) => `markets:${marketId}`,
  },
  invalidateMarketCache: jest.fn().mockResolvedValue(undefined),
}));

import { usersRouter } from "../../src/routes/users";
import { userPortfolioRouter } from "../../src/routes/users/portfolio";
import { userStatsRouter } from "../../src/routes/users/stats";
import { createUsersHealthRouter } from "../../src/routes/users/health";

const VALID_STELLAR_ADDRESS = "GB3KKYQ3P2HYGJJTZY6L4EWTZTVR2YJJU5P44T7RMFKJWKXG3L4TXZF6";
const VALID_ADDRESS_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const INVALID_ADDRESS = "not-a-valid-stellar-address";

async function seedUser(id: string, stellarAddress: string) {
  await pool.query(
    `INSERT INTO users (id, stellar_address, created_at) VALUES ($1, $2, NOW())`,
    [id, stellarAddress],
  );
}

async function seedMarket(id: string, question: string, status: string, resolutionTime: string) {
  await pool.query(
    `INSERT INTO markets (id, question, status, resolution_time, indexed_ledger, archived, version, featured, created_at)
     VALUES ($1, $2, $3, $4, 1, false, 1, false, NOW())`,
    [id, question, status, resolutionTime],
  );
}

async function seedPrediction(id: string, userId: string, marketId: string, outcome: string, amount: string, status: string = "pending") {
  await pool.query(
    `INSERT INTO predictions (id, user_id, market_id, outcome, amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [id, userId, marketId, outcome, amount, status],
  );
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    requestContextStorage.run({ requestId: uuidv4() }, next);
  });
  app.use("/api/users/health", createUsersHealthRouter());
  app.use("/api/users", userPortfolioRouter);
  app.use("/api/users", userStatsRouter);
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

function tokenFor(stellarAddress: string): string {
  return signAccessToken({ sub: stellarAddress });
}

describe("Integration Test: /api/users", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE users, markets, predictions RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await closeAuthPool();
    await closeDb();
  });

  describe("GET /api/users", () => {
    it("returns an empty list when no users exist", async () => {
      const res = await request(app).get("/api/users");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], nextCursor: null });
    });

    it("returns users sorted by newest first", async () => {
      const oldId = "d0000000-0000-0000-0000-000000000001";
      const newId = "d0000000-0000-0000-0000-000000000002";

      await pool.query(
        `INSERT INTO users (id, stellar_address, created_at) VALUES ($1, $2, $3)`,
        [oldId, VALID_STELLAR_ADDRESS, "2025-01-01T00:00:00.000Z"],
      );
      await pool.query(
        `INSERT INTO users (id, stellar_address, created_at) VALUES ($1, $2, $3)`,
        [newId, VALID_ADDRESS_2, "2026-01-01T00:00:00.000Z"],
      );

      const res = await request(app).get("/api/users");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].id).toBe(newId);
      expect(res.body.data[1].id).toBe(oldId);
      expect(res.body.nextCursor).toBeNull();
    });

    it("respects the limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await pool.query(
          `INSERT INTO users (id, stellar_address, created_at) VALUES ($1, $2, NOW())`,
          [`d0000000-0000-0000-0000-00000000001${i}`, `G${"A".repeat(55 - String(i).length)}${i}`],
        );
      }

      const res = await request(app).get("/api/users?limit=2");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });

    it("supports cursor-based pagination", async () => {
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO users (id, stellar_address, created_at) VALUES ($1, $2, $3)`,
          [
            `d0000000-0000-0000-0000-00000000003${i}`,
            `G${"B".repeat(55 - String(i).length)}${i}`,
            `2026-07-${String(1 + i).padStart(2, "0")}T00:00:00.000Z`,
          ],
        );
      }

      const page1 = await request(app).get("/api/users?limit=2");

      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await request(app).get(
        `/api/users?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      );

      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
    });

    it("returns 400 when limit exceeds the maximum", async () => {
      const res = await request(app).get("/api/users?limit=101");

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "validation_error");
    });

    it("returns 400 when limit is not a number", async () => {
      const res = await request(app).get("/api/users?limit=abc");

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "validation_error");
    });

    it("includes x-request-id in response headers", async () => {
      const res = await request(app).get("/api/users");

      expect(res.headers["x-request-id"]).toBeDefined();
    });

    it("includes x-correlation-id in response headers", async () => {
      const res = await request(app).get("/api/users");

      expect(res.headers["x-correlation-id"]).toBeDefined();
    });

    it("silently restarts from page 1 for a garbage cursor", async () => {
      await seedUser("d0000000-0000-0000-0000-000000000099", VALID_STELLAR_ADDRESS);

      const res = await request(app).get("/api/users?cursor=not-a-valid-cursor");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe("GET /api/users/me", () => {
    it("returns 403 if unauthenticated", async () => {
      const res = await request(app).get("/api/users/me");

      expect(res.status).toBe(403);
      expect(res.body.error).toHaveProperty("code", "forbidden");
    });

    it("returns 403 if user not found in database", async () => {
      const token = tokenFor("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
      const res = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toHaveProperty("code", "forbidden");
    });

    it("returns 200 with user profile when authenticated", async () => {
      const userId = "d0000000-0000-0000-0000-000000000010";
      await seedUser(userId, VALID_STELLAR_ADDRESS);
      const token = tokenFor(VALID_STELLAR_ADDRESS);

      const res = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("stellarAddress", VALID_STELLAR_ADDRESS);
      expect(res.body.data).toHaveProperty("totals");
      expect(res.body.data.totals).toHaveProperty("prediction_count");
      expect(res.body.data.totals).toHaveProperty("totalPredictions");
    });

    it("returns x-correlation-id header on success", async () => {
      const userId = "d0000000-0000-0000-0000-000000000011";
      await seedUser(userId, VALID_STELLAR_ADDRESS);
      const token = tokenFor(VALID_STELLAR_ADDRESS);

      const res = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.headers["x-correlation-id"]).toBeDefined();
    });

    it("returns 403 with an invalid token", async () => {
      const res = await request(app)
        .get("/api/users/me")
        .set("Authorization", "Bearer not-a-real-jwt");

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/users/:address/predictions", () => {
    it("returns 400 for invalid stellar address", async () => {
      const res = await request(app).get(`/api/users/${INVALID_ADDRESS}/predictions`);

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "invalid_address");
    });

    it("returns 404 for unknown user", async () => {
      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/predictions`);

      expect(res.status).toBe(404);
      expect(res.body.error).toHaveProperty("code", "not_found");
    });

    it("returns predictions for a user", async () => {
      const userId = "d0000000-0000-0000-0000-000000000020";
      const marketId = "market-pred-1";
      const predictionId = "p0000000-0000-0000-0000-000000000020";

      await seedUser(userId, VALID_STELLAR_ADDRESS);
      await seedMarket(marketId, "Will it rain?", "active", "2026-08-01T00:00:00.000Z");
      await seedPrediction(predictionId, userId, marketId, "YES", "10.0", "confirmed");

      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/predictions`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: predictionId,
        marketId,
        outcome: "YES",
        amount: "10.0",
        status: "confirmed",
      });
      expect(res.body.nextCursor).toBeNull();
    });

    it("filters predictions by status", async () => {
      const userId = "d0000000-0000-0000-0000-000000000021";
      const marketId = "market-status";

      await seedUser(userId, VALID_STELLAR_ADDRESS);
      await seedMarket(marketId, "Market A", "active", "2026-08-01T00:00:00.000Z");
      await seedPrediction("p1-id", userId, marketId, "YES", "5.0", "pending");
      await seedPrediction("p2-id", userId, marketId, "NO", "5.0", "won");

      const res = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions?status=won`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("won");
    });

    it("returns 400 for an invalid status enum value", async () => {
      await seedUser("d0000000-0000-0000-0000-000000000022", VALID_STELLAR_ADDRESS);

      const res = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions?status=invalid-status`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "validation_error");
    });

    it("returns 400 when limit exceeds the maximum", async () => {
      await seedUser("d0000000-0000-0000-0000-000000000023", VALID_STELLAR_ADDRESS);

      const res = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions?limit=101`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "validation_error");
    });

    it("returns 400 for unexpected query parameters", async () => {
      await seedUser("d0000000-0000-0000-0000-000000000024", VALID_STELLAR_ADDRESS);

      const res = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions?unknown=param`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "validation_error");
    });

    it("supports cursor-based pagination", async () => {
      const userId = "d0000000-0000-0000-0000-000000000025";
      const marketId = "market-page";

      await seedUser(userId, VALID_STELLAR_ADDRESS);
      await seedMarket(marketId, "Paginated market", "active", "2026-09-01T00:00:00.000Z");

      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO predictions (id, user_id, market_id, outcome, amount, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            `p-page-${i}`,
            userId,
            marketId,
            "YES",
            "10",
            "pending",
            `2026-07-${String(1 + i).padStart(2, "0")}T00:00:00.000Z`,
          ],
        );
      }

      const page1 = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions?limit=2`,
      );

      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      );

      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
    });

    it("includes x-request-id header", async () => {
      const userId = "d0000000-0000-0000-0000-000000000026";
      await seedUser(userId, VALID_STELLAR_ADDRESS);

      const res = await request(app).get(
        `/api/users/${VALID_STELLAR_ADDRESS}/predictions`,
      );

      expect(res.headers["x-request-id"]).toBeDefined();
    });
  });

  describe("GET /api/users/:stellarAddress/profile", () => {
    it("returns 422 for an invalid stellar address", async () => {
      const res = await request(app).get(`/api/users/${INVALID_ADDRESS}/profile`);

      expect(res.status).toBe(422);
      expect(res.body.error).toHaveProperty("code", "validation_error");
    });

    it("returns 404 for an unknown user", async () => {
      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/profile`);

      expect(res.status).toBe(404);
      expect(res.body.error).toHaveProperty("code", "not_found");
    });

    it("returns 200 with profile data for an existing user", async () => {
      const userId = "d0000000-0000-0000-0000-000000000030";
      const marketId = "market-profile";
      const predId = "p-profile-1";

      await seedUser(userId, VALID_STELLAR_ADDRESS);
      await seedMarket(marketId, "Profile market", "active", "2026-08-01T00:00:00.000Z");
      await seedPrediction(predId, userId, marketId, "YES", "25.0", "pending");

      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/profile`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("stellarAddress", VALID_STELLAR_ADDRESS);
      expect(res.body.data).toHaveProperty("totals");
      expect(res.body.data).toHaveProperty("predictions");
    });

    it("includes x-correlation-id header", async () => {
      const userId = "d0000000-0000-0000-0000-000000000031";
      await seedUser(userId, VALID_STELLAR_ADDRESS);

      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/profile`);

      expect(res.headers["x-correlation-id"]).toBeDefined();
    });
  });

  describe("GET /api/users/:addr/portfolio", () => {
    it("returns 400 for an invalid stellar address", async () => {
      const res = await request(app).get(`/api/users/${INVALID_ADDRESS}/portfolio`);

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "invalid_address");
    });

    it("returns 404 for an unknown user", async () => {
      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/portfolio`);

      expect(res.status).toBe(404);
      expect(res.body.error).toHaveProperty("code", "not_found");
    });

    it("returns 200 with portfolio data for a user with predictions", async () => {
      const userId = "d0000000-0000-0000-0000-000000000040";
      const marketId = "market-portfolio";

      await seedUser(userId, VALID_STELLAR_ADDRESS);
      await seedMarket(marketId, "Portfolio market", "active", "2026-08-01T00:00:00.000Z");

      await seedPrediction("p-portfolio-1", userId, marketId, "YES", "50.0", "pending");
      await seedPrediction("p-portfolio-2", userId, marketId, "NO", "30.0", "won");

      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/portfolio`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("address", VALID_STELLAR_ADDRESS);
      expect(res.body.data).toHaveProperty("totals");
      expect(res.body.data.totals).toHaveProperty("predictionCount");
      expect(res.body.data.totals).toHaveProperty("marketCount");
      expect(res.body.data.totals).toHaveProperty("totalStaked");
      expect(res.body.data).toHaveProperty("markets");
      expect(Array.isArray(res.body.data.markets)).toBe(true);
      expect(res.body.data).toHaveProperty("cachedAt");
    });
  });

  describe("GET /api/users/:addr/stats", () => {
    it("returns 400 for an invalid stellar address", async () => {
      const res = await request(app).get(`/api/users/${INVALID_ADDRESS}/stats`);

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("code", "invalid_address");
    });

    it("returns 404 for an unknown user", async () => {
      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/stats`);

      expect(res.status).toBe(404);
      expect(res.body.error).toHaveProperty("code", "not_found");
    });

    it("returns 200 with stats data for a user with predictions", async () => {
      const userId = "d0000000-0000-0000-0000-000000000050";
      const marketId = "market-stats";

      await seedUser(userId, VALID_STELLAR_ADDRESS);
      await seedMarket(marketId, "Stats market", "active", "2026-08-01T00:00:00.000Z");
      await seedPrediction("p-stats-1", userId, marketId, "YES", "100.0", "won");
      await seedPrediction("p-stats-2", userId, marketId, "NO", "50.0", "pending");

      const res = await request(app).get(`/api/users/${VALID_STELLAR_ADDRESS}/stats`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("address", VALID_STELLAR_ADDRESS);
      expect(res.body.data).toHaveProperty("totalPredictions");
      expect(res.body.data).toHaveProperty("totalStaked");
      expect(res.body.data).toHaveProperty("marketsParticipated");
      expect(res.body.data).toHaveProperty("byStatus");
      expect(res.body.data).toHaveProperty("winRate");
      expect(res.body.data).toHaveProperty("cachedAt");
    });
  });

  describe("GET /api/users/health", () => {
    it("returns 200 with database status ok", async () => {
      const res = await request(app).get("/api/users/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "ok");
      expect(res.body).toHaveProperty("correlationId");
      expect(res.body).toHaveProperty("checkedAt");
      expect(res.body.dependencies).toHaveProperty("database");
      expect(res.body.dependencies.database).toHaveProperty("status", "ok");
      expect(res.body.dependencies.database).toHaveProperty("latencyMs");
      expect(typeof res.body.dependencies.database.latencyMs).toBe("number");
    });

    it("returns checkedAt as an ISO 8601 string", async () => {
      const res = await request(app).get("/api/users/health");

      expect(res.body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("returns x-correlation-id header", async () => {
      const res = await request(app).get("/api/users/health");

      expect(res.headers["x-correlation-id"]).toBeDefined();
    });
  });
});
