import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { closeDb, pool } from "../../src/db/client";
import { signAccessToken } from "../../src/services/jwtService";
import { requestContextStorage } from "../../src/lib/requestContext";
import { closeAuthPool } from "../../src/middleware/requireAuth";

import { predictionsRouter } from "../../src/routes/predictions";

/**
 * Mirrors the request-id + AsyncLocalStorage wiring `createApp()` sets up in
 * src/index.ts (minus pinoHttp/helmet, which aren't relevant here) so route
 * handlers that call `getRequestId()` behave the same as they would in the
 * full app instead of silently returning undefined.
 */
function createPredictionsApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    requestContextStorage.run({ requestId: uuidv4() }, next);
  });
  app.use("/api/predictions", predictionsRouter);
  return app;
}

async function seedUser(stellarAddress: string): Promise<string> {
  const res = await pool.query(
    `INSERT INTO users (stellar_address) VALUES ($1) RETURNING id`,
    [stellarAddress],
  );
  return res.rows[0].id as string;
}

async function seedMarket(row: {
  id: string;
  question: string;
  status: string;
  resolutionTime: string;
}) {
  await pool.query(
    `
      INSERT INTO markets (
        id, question, status, resolution_time, indexed_ledger, archived, version, featured
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [row.id, row.question, row.status, row.resolutionTime, 1, false, 1, false],
  );
}

async function seedPrediction(row: {
  id?: string;
  marketId: string;
  userId: string;
  outcome: string;
  amount?: string;
  status?: string;
  createdAt?: string;
}) {
  const res = await pool.query(
    `
      INSERT INTO predictions (
        market_id, user_id, outcome, amount, status, created_at
      )
      VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
      RETURNING id
    `,
    [
      row.marketId,
      row.userId,
      row.outcome,
      row.amount ?? "10",
      row.status ?? "pending",
      row.createdAt ?? null,
    ],
  );
  return res.rows[0].id as string;
}

function tokenFor(stellarAddress: string): string {
  return signAccessToken({ sub: stellarAddress });
}

describe("GET /api/predictions integration", () => {
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE predictions, markets, users RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    // requireAuth.ts owns its own pg Pool, independent of src/db/client's —
    // this is the first integration suite to exercise an authenticated
    // route, so it's also the first to need to close it. Without this, the
    // pool's open connections get killed when the Testcontainers Postgres
    // shuts down and crash the process with an unhandled 'error' event even
    // though every test already passed.
    await closeAuthPool();
    await closeDb();
  });

  describe("authentication boundary", () => {
    it("returns 401 when no Authorization header is provided", async () => {
      const res = await request(createPredictionsApp()).get("/api/predictions");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "unauthenticated" } });
    });

    it("returns 401 when the token is malformed", async () => {
      const res = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", "Bearer not-a-real-jwt");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "unauthenticated" } });
    });

    it("returns 401 when the token's subject has no matching user row", async () => {
      const res = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", `Bearer ${tokenFor("GUNKNOWNADDRESS")}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "unauthenticated" } });
    });
  });

  describe("successful listing", () => {
    it("returns predictions belonging to the authenticated user", async () => {
      const userId = await seedUser("GUSERONE");
      await seedMarket({
        id: "market-1",
        question: "Will it rain?",
        status: "active",
        resolutionTime: "2026-08-01T00:00:00.000Z",
      });
      const predictionId = await seedPrediction({
        marketId: "market-1",
        userId,
        outcome: "yes",
        amount: "25",
        status: "confirmed",
      });

      const res = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", `Bearer ${tokenFor("GUSERONE")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        id: predictionId,
        marketId: "market-1",
        question: "Will it rain?",
        outcome: "yes",
        amount: "25",
        status: "confirmed",
      });
      expect(res.body.next_cursor).toBeNull();
      expect(res.body.total).toBeUndefined();
    });

    it("only returns predictions scoped to the authenticated user (never another user's)", async () => {
      const userAId = await seedUser("GUSERA");
      const userBId = await seedUser("GUSERB");
      await seedMarket({
        id: "market-shared",
        question: "Shared market",
        status: "active",
        resolutionTime: "2026-08-02T00:00:00.000Z",
      });
      await seedPrediction({ marketId: "market-shared", userId: userAId, outcome: "yes" });
      await seedPrediction({ marketId: "market-shared", userId: userBId, outcome: "no" });

      const res = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", `Bearer ${tokenFor("GUSERA")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].outcome).toBe("yes");
    });

    it("returns an empty page (not an error) for a user with no predictions", async () => {
      await seedUser("GLONELYUSER");

      const res = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", `Bearer ${tokenFor("GLONELYUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], next_cursor: null });
    });
  });

  describe("filtering", () => {
    let userId: string;

    beforeEach(async () => {
      userId = await seedUser("GFILTERUSER");
      await seedMarket({
        id: "market-a",
        question: "Market A",
        status: "active",
        resolutionTime: "2026-08-03T00:00:00.000Z",
      });
      await seedMarket({
        id: "market-b",
        question: "Market B",
        status: "active",
        resolutionTime: "2026-08-04T00:00:00.000Z",
      });
      await seedPrediction({ marketId: "market-a", userId, outcome: "yes", status: "pending" });
      await seedPrediction({ marketId: "market-a", userId, outcome: "no", status: "won" });
      await seedPrediction({ marketId: "market-b", userId, outcome: "yes", status: "pending" });
    });

    it("filters by marketId", async () => {
      const res = await request(createPredictionsApp())
        .get("/api/predictions?marketId=market-b")
        .set("Authorization", `Bearer ${tokenFor("GFILTERUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].marketId).toBe("market-b");
    });

    it("filters by status", async () => {
      const res = await request(createPredictionsApp())
        .get("/api/predictions?status=won")
        .set("Authorization", `Bearer ${tokenFor("GFILTERUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].status).toBe("won");
    });

    it("filters by outcome", async () => {
      const res = await request(createPredictionsApp())
        .get("/api/predictions?outcome=yes")
        .set("Authorization", `Bearer ${tokenFor("GFILTERUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      res.body.items.forEach((p: { outcome: string }) => expect(p.outcome).toBe("yes"));
    });

    it("combines multiple filters", async () => {
      const res = await request(createPredictionsApp())
        .get("/api/predictions?marketId=market-a&outcome=yes")
        .set("Authorization", `Bearer ${tokenFor("GFILTERUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ marketId: "market-a", outcome: "yes" });
    });
  });

  describe("pagination", () => {
    it("respects the limit query parameter and returns a nextCursor when more rows exist", async () => {
      const userId = await seedUser("GPAGEUSER");
      await seedMarket({
        id: "market-page",
        question: "Pagination market",
        status: "active",
        resolutionTime: "2026-08-05T00:00:00.000Z",
      });

      // Seed 3 predictions with distinct, increasing createdAt so ordering is deterministic.
      await seedPrediction({
        marketId: "market-page",
        userId,
        outcome: "yes",
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      await seedPrediction({
        marketId: "market-page",
        userId,
        outcome: "yes",
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      const third = await seedPrediction({
        marketId: "market-page",
        userId,
        outcome: "yes",
        createdAt: "2026-07-03T00:00:00.000Z",
      });

      const page1 = await request(createPredictionsApp())
        .get("/api/predictions?limit=2")
        .set("Authorization", `Bearer ${tokenFor("GPAGEUSER")}`);

      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      // Most-recent-first: the 2026-07-03 row (id `third`) should be first.
      expect(page1.body.items[0].id).toBe(third);
      expect(page1.body.next_cursor).toEqual(expect.any(String));

      const page2 = await request(createPredictionsApp())
        .get(`/api/predictions?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`)
        .set("Authorization", `Bearer ${tokenFor("GPAGEUSER")}`);

      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.next_cursor).toBeNull();
    });

    it("silently restarts from page 1 for a garbage cursor instead of erroring", async () => {
      const userId = await seedUser("GBADCURSORUSER");
      await seedMarket({
        id: "market-bad-cursor",
        question: "Bad cursor market",
        status: "active",
        resolutionTime: "2026-08-06T00:00:00.000Z",
      });
      await seedPrediction({ marketId: "market-bad-cursor", userId, outcome: "yes" });

      const res = await request(createPredictionsApp())
        .get("/api/predictions?cursor=not-a-real-cursor")
        .set("Authorization", `Bearer ${tokenFor("GBADCURSORUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });
  });

  describe("input validation", () => {
    it("returns 400 validation_error for an invalid status enum value", async () => {
      await seedUser("GVALIDATIONUSER");

      const res = await request(createPredictionsApp())
        .get("/api/predictions?status=not-a-real-status")
        .set("Authorization", `Bearer ${tokenFor("GVALIDATIONUSER")}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
      expect(res.body.error.requestId).toEqual(expect.any(String));
    });

    it("returns 429 once the per-user limit is exceeded", async () => {
      await seedUser("GRATELIMITUSER");
      const token = tokenFor("GRATELIMITUSER");

      for (let index = 0; index < 60; index += 1) {
        const res = await request(createPredictionsApp())
          .get("/api/predictions")
          .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
      }

      const blocked = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", `Bearer ${token}`);

      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toMatchObject({
        code: "rate_limit_exceeded",
        retryAfter: expect.any(Number),
      });
    });

    it("returns 400 validation_error when limit exceeds the maximum", async () => {
      await seedUser("GLIMITUSER");

      const res = await request(createPredictionsApp())
        .get("/api/predictions?limit=1000")
        .set("Authorization", `Bearer ${tokenFor("GLIMITUSER")}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error when limit is not a positive integer", async () => {
      await seedUser("GZEROLIMITUSER");

      const res = await request(createPredictionsApp())
        .get("/api/predictions?limit=0")
        .set("Authorization", `Bearer ${tokenFor("GZEROLIMITUSER")}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 validation_error for unexpected query parameters", async () => {
      await seedUser("GUNEXPECTEDQUERYUSER");

      const res = await request(createPredictionsApp())
        .get("/api/predictions?status=won&unexpected=true")
        .set("Authorization", `Bearer ${tokenFor("GUNEXPECTEDQUERYUSER")}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("defaults to the standard page size when limit is omitted", async () => {
      const userId = await seedUser("GDEFAULTLIMITUSER");
      await seedMarket({
        id: "market-default-limit",
        question: "Default limit market",
        status: "active",
        resolutionTime: "2026-08-07T00:00:00.000Z",
      });
      await seedPrediction({ marketId: "market-default-limit", userId, outcome: "yes" });

      const res = await request(createPredictionsApp())
        .get("/api/predictions")
        .set("Authorization", `Bearer ${tokenFor("GDEFAULTLIMITUSER")}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });
  });
});
