import request from "supertest";
import { closeDb, pool } from "../../src/db/client";
import { signAccessToken } from "../../src/services/jwtService";

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

async function seedUser(id: string, stellarAddress: string) {
  await pool.query(
    `INSERT INTO users (id, stellar_address, created_at) VALUES ($1, $2, NOW())`,
    [id, stellarAddress]
  );
}

async function seedMarket(id: string, question: string, status: string, resolutionTime: string) {
  await pool.query(
    `INSERT INTO markets (id, question, status, resolution_time, indexed_ledger, archived, version, featured, created_at)
     VALUES ($1, $2, $3, $4, 1, false, 1, false, NOW())`,
    [id, question, status, resolutionTime]
  );
}

async function seedPrediction(id: string, userId: string, marketId: string, outcome: string, amount: string, status: string = 'pending') {
  await pool.query(
    `INSERT INTO predictions (id, user_id, market_id, outcome, amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [id, userId, marketId, outcome, amount, status]
  );
}

import express from "express";
import { usersRouter } from "../../src/routes/users";

function createUsersApp() {
  const app = express();
  app.use(express.json());
  
  // mock res.locals.correlationId since accessLog relies on it if we don't include all middlewares
  app.use((req, res, next) => {
    res.locals.correlationId = "test-id";
    next();
  });
  
  app.use("/api/users", usersRouter);
  
  // Global error handler mock
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.status(err.status || 500).json({ error: { code: err.code || "unknown", type: err.type || err.name, message: err.message } });
  });

  return app;
}

describe("Integration Test: /api/users", () => {
  let app: any;

  beforeAll(() => {
    app = createUsersApp();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE users, markets, predictions RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("GET /api/users/me", () => {
    it("returns 403 if unauthenticated", async () => {
      const response = await request(app).get("/api/users/me").expect(403);
      expect(response.body.error).toHaveProperty("code", "forbidden");
    });

    it("returns 403 if user not found", async () => {
      const token = signAccessToken({ sub: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" });
      const response = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
      expect(response.body.error).toHaveProperty("code", "forbidden");
    });

    it("returns 200 with user profile when authenticated", async () => {
      const userId = "d0000000-0000-0000-0000-000000000000";
      const address = "GB3KKYQ3P2HYGJJTZY6L4EWTZTVR2YJJU5P44T7RMFKJWKXG3L4TXZF6";
      await seedUser(userId, address);
      
      const token = signAccessToken({ sub: address });
      const response = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(response.body.data).toHaveProperty("stellarAddress", address);
      expect(response.body.data).toHaveProperty("totals");
      expect(response.body.data.totals).toHaveProperty("prediction_count", 0);
    });
  });

  describe("GET /api/users/:address/predictions", () => {
    it("returns 400 for invalid stellar address", async () => {
      const response = await request(app).get("/api/users/invalid-address/predictions").expect(400);
      expect(response.body.error).toHaveProperty("code", "invalid_address");
    });

    it("returns 404 for unknown user", async () => {
      const response = await request(app).get("/api/users/GB3KKYQ3P2HYGJJTZY6L4EWTZTVR2YJJU5P44T7RMFKJWKXG3L4TXZF6/predictions").expect(404);
      expect(response.body.error).toHaveProperty("code", "not_found");
    });

    it("returns predictions for a user", async () => {
      const userId = "d0000000-0000-0000-0000-000000000001";
      const address = "GB3KKYQ3P2HYGJJTZY6L4EWTZTVR2YJJU5P44T7RMFKJWKXG3L4TXZF6";
      const marketId = "market-1";
      const predictionId = "p0000000-0000-0000-0000-000000000001";

      await seedUser(userId, address);
      await seedMarket(marketId, "Will it rain?", "active", "2026-07-01T00:00:00.000Z");
      await seedPrediction(predictionId, userId, marketId, "YES", "10.0");

      const response = await request(app).get(`/api/users/${address}/predictions`).expect(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({ id: predictionId, marketId: marketId, outcome: "YES", amount: "10.0" });
    });
    
    it("validates query parameters properly", async () => {
      const userId = "d0000000-0000-0000-0000-000000000002";
      const address = "GB3KKYQ3P2HYGJJTZY6L4EWTZTVR2YJJU5P44T7RMFKJWKXG3L4TXZF6";
      await seedUser(userId, address);
      const response = await request(app).get(`/api/users/${address}/predictions?limit=999`).expect(400);
      expect(response.body.error.code).toEqual("validation_error");
    });
  });

  describe("GET /api/users/:stellarAddress/profile", () => {
    it("returns 400 for invalid stellar address", async () => {
      const response = await request(app).get("/api/users/invalid/profile").expect(400);
      expect(response.body.error.type).toEqual("ValidationError");
    });

    it("returns 404 for unknown user profile", async () => {
      const response = await request(app).get("/api/users/GB3KKYQ3P2HYGJJTZY6L4EWTZTVR2YJJU5P44T7RMFKJWKXG3L4TXZF6/profile").expect(404);
      expect(response.body.error.type).toEqual("NotFound");
    });
  });
});
