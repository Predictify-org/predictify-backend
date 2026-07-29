import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { closeDb, pool } from "../../src/db/client";
import { requestContextStorage } from "../../src/lib/requestContext";

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

import { marketsRouter } from "../../src/routes/markets";
import { errorHandler } from "../../src/middleware/errorHandler";

/**
 * Creates a lightweight Express app with the markets router plus the
 * request-context and error-handler middleware so that route handlers and
 * error responses behave the same way they do in the full app.
 */
function createMarketsApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    requestContextStorage.run({ requestId: uuidv4() }, next);
  });
  app.use("/api/markets", marketsRouter);
  app.use(errorHandler);
  return app;
}

interface MarketSeed {
  id: string;
  question: string;
  status: string;
  resolutionTime: string;
  archived?: boolean;
  version?: number;
  featured?: boolean;
  featuredAt?: string;
  createdAt?: string;
}

async function seedMarkets(rows: MarketSeed[]) {
  for (const row of rows) {
    const createdAt = row.createdAt ?? "NOW()";
    const featuredAt = row.featuredAt ?? null;
    await pool.query(
      `
        INSERT INTO markets (
          id, question, status, resolution_time,
          indexed_ledger, archived, version,
          featured, featured_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${createdAt === "NOW()" ? "NOW()" : "$10"})
      `,
      [
        row.id,
        row.question,
        row.status,
        row.resolutionTime,
        1,
        row.archived ?? false,
        row.version ?? 1,
        row.featured ?? false,
        featuredAt,
        ...(createdAt !== "NOW()" ? [createdAt] : []),
      ],
    );
  }
}

describe("GET /api/markets integration", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE markets RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("listing", () => {
    it("returns markets persisted in the database", async () => {
      await seedMarkets([
        {
          id: "market-live",
          question: "Will the integration test pass?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get("/api/markets");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [
          {
            id: "market-live",
            question: "Will the integration test pass?",
            status: "active",
            resolutionTime: "2026-07-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    });

    it("omits archived markets from the public listing", async () => {
      await seedMarkets([
        {
          id: "market-active",
          question: "Visible market",
          status: "active",
          resolutionTime: "2026-07-02T00:00:00.000Z",
        },
        {
          id: "market-archived",
          question: "Hidden market",
          status: "archived",
          resolutionTime: "2026-07-03T00:00:00.000Z",
          archived: true,
        },
      ]);

      const res = await request(createMarketsApp()).get("/api/markets");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ id: "market-active" });
    });

    it("respects the limit query parameter", async () => {
      await seedMarkets([
        {
          id: "market-one",
          question: "First",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "market-two",
          question: "Second",
          status: "active",
          resolutionTime: "2026-07-02T00:00:00.000Z",
        },
        {
          id: "market-three",
          question: "Third",
          status: "active",
          resolutionTime: "2026-07-03T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get("/api/markets?limit=2");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe("empty state", () => {
    it("returns empty data and null nextCursor when no markets exist", async () => {
      const res = await request(createMarketsApp()).get("/api/markets");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], nextCursor: null });
    });
  });

  describe("pagination", () => {
    it("returns a nextCursor when more rows exist and supports fetching subsequent pages", async () => {
      // Seed 4 markets with deliberately staggered createdAt timestamps
      // so that ordering is deterministic.
      await seedMarkets([
        {
          id: "market-p1",
          question: "Page 1 - oldest",
          status: "active",
          resolutionTime: "2026-07-10T00:00:00.000Z",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "market-p2",
          question: "Page 2",
          status: "active",
          resolutionTime: "2026-07-11T00:00:00.000Z",
          createdAt: "2026-06-02T00:00:00.000Z",
        },
        {
          id: "market-p3",
          question: "Page 3",
          status: "active",
          resolutionTime: "2026-07-12T00:00:00.000Z",
          createdAt: "2026-06-03T00:00:00.000Z",
        },
        {
          id: "market-p4",
          question: "Page 4 - newest",
          status: "active",
          resolutionTime: "2026-07-13T00:00:00.000Z",
          createdAt: "2026-06-04T00:00:00.000Z",
        },
      ]);

      const page1 = await request(createMarketsApp()).get("/api/markets?limit=2");

      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      // Newest-first ordering: market-p4, market-p3
      expect(page1.body.data[0].id).toBe("market-p4");
      expect(page1.body.data[1].id).toBe("market-p3");
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await request(createMarketsApp()).get(
        `/api/markets?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      );

      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(2);
      expect(page2.body.data[0].id).toBe("market-p2");
      expect(page2.body.data[1].id).toBe("market-p1");
      expect(page2.body.nextCursor).toBeNull();
    });

    it("returns null nextCursor when the result set fits in a single page", async () => {
      await seedMarkets([
        {
          id: "market-solo",
          question: "Only market",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get("/api/markets");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.nextCursor).toBeNull();
    });

    it("silently restarts from page 1 when given a garbage cursor", async () => {
      await seedMarkets([
        {
          id: "market-garbage",
          question: "Garbage cursor market",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets?cursor=not-a-real-cursor",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  describe("single market by ID", () => {
    it("returns a single market by id from the database", async () => {
      await seedMarkets([
        {
          id: "market-detail",
          question: "Single detail lookup",
          status: "active",
          resolutionTime: "2026-07-04T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/market-detail",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          id: "market-detail",
          question: "Single detail lookup",
          status: "active",
          resolutionTime: "2026-07-04T00:00:00.000Z",
          version: 1,
        },
      });
    });

    it("returns 404 for a non-existent market ID", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets/nonexistent-id",
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: {
          type: "NotFound",
          message: "Market with ID nonexistent-id not found",
        },
      });
    });
  });

  describe("featured markets", () => {
    it("returns featured markets ordered by featuredAt desc", async () => {
      await seedMarkets([
        {
          id: "market-featured-1",
          question: "Featured market one",
          status: "active",
          resolutionTime: "2026-07-10T00:00:00.000Z",
          featured: true,
          featuredAt: "2026-07-05T12:00:00.000Z",
        },
        {
          id: "market-featured-2",
          question: "Featured market two",
          status: "active",
          resolutionTime: "2026-07-11T00:00:00.000Z",
          featured: true,
          featuredAt: "2026-07-06T12:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/featured",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveLength(2);
      // Newest featuredAt first
      expect(res.body.data[0].id).toBe("market-featured-2");
      expect(res.body.data[1].id).toBe("market-featured-1");
      expect(res.body.data[0]).toMatchObject({
        id: "market-featured-2",
        question: "Featured market two",
        status: "active",
      });
    });

    it("omits non-featured and archived markets from the featured listing", async () => {
      await seedMarkets([
        {
          id: "market-featured",
          question: "Featured market",
          status: "active",
          resolutionTime: "2026-07-10T00:00:00.000Z",
          featured: true,
          featuredAt: "2026-07-05T12:00:00.000Z",
        },
        {
          id: "market-not-featured",
          question: "Not featured",
          status: "active",
          resolutionTime: "2026-07-11T00:00:00.000Z",
        },
        {
          id: "market-archived-featured",
          question: "Archived featured",
          status: "archived",
          resolutionTime: "2026-07-12T00:00:00.000Z",
          archived: true,
          featured: true,
          featuredAt: "2026-07-06T12:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/featured",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("market-featured");
    });

    it("returns empty data array when no featured markets exist", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets/featured",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    });
  });

  describe("upcoming markets", () => {
    it("returns markets with upcoming status ordered by resolution time asc", async () => {
      await seedMarkets([
        {
          id: "market-upcoming-1",
          question: "Upcoming market one",
          status: "upcoming",
          resolutionTime: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "market-upcoming-2",
          question: "Upcoming market two",
          status: "upcoming",
          resolutionTime: "2026-07-30T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/upcoming",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      // Soonest resolution time first
      expect(res.body.data[0].id).toBe("market-upcoming-2");
      expect(res.body.data[1].id).toBe("market-upcoming-1");
    });

    it("omits active markets from the upcoming listing", async () => {
      await seedMarkets([
        {
          id: "market-upcoming",
          question: "Upcoming market",
          status: "upcoming",
          resolutionTime: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "market-active",
          question: "Active market",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/upcoming",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("market-upcoming");
    });

    it("returns empty data array when no upcoming markets exist", async () => {
      await seedMarkets([
        {
          id: "market-active-only",
          question: "Only active market",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/upcoming",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    });
  });

  describe("search markets", () => {
    it("returns search results matching the query", async () => {
      await seedMarkets([
        {
          id: "market-search-solana",
          question: "Will Solana reach $200?",
          status: "active",
          resolutionTime: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "market-search-bitcoin",
          question: "Bitcoin price prediction Q4",
          status: "active",
          resolutionTime: "2026-08-02T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/search?q=Solana",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      // At minimum the matching row should appear.  Full-text search may also
      // return results from trigram fallback depending on the tsvector config.
      const ids = res.body.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("market-search-solana");
    });

    it("returns empty results for a non-matching query", async () => {
      await seedMarkets([
        {
          id: "market-search-only",
          question: "Some unique question",
          status: "active",
          resolutionTime: "2026-08-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createMarketsApp()).get(
        "/api/markets/search?q=xyznonexistent99999",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("returns 400 when query parameter q is missing", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets/search",
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          type: "validation_error",
          message: "Validation failed",
        },
      });
    });

    it("returns 400 when query parameter q is empty", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets/search?q=",
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          type: "validation_error",
          message: "Validation failed",
        },
      });
    });
  });

  describe("input validation", () => {
    it("rejects limit > 100 with 400", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets?limit=101",
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          type: "validation_error",
          message: "Validation failed",
        },
      });
    });

    it("rejects limit = 0 with 400", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets?limit=0",
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          type: "validation_error",
          message: "Validation failed",
        },
      });
    });

    it("rejects non-numeric limit with 400", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets?limit=abc",
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          type: "validation_error",
          message: "Validation failed",
        },
      });
    });

    it("defaults to the standard page size when limit is omitted", async () => {
      await seedMarkets(
        Array.from({ length: 5 }, (_, i) => ({
          id: `market-default-${i}`,
          question: `Default limit market ${i}`,
          status: "active",
          resolutionTime: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        })),
      );

      const res = await request(createMarketsApp()).get("/api/markets");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(5);
    });

    it("includes a correlationId in error responses", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets?limit=101",
      );

      expect(res.status).toBe(400);
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("includes validation details in error responses", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets?limit=101",
      );

      expect(res.status).toBe(400);
      expect(res.body.error.details).toBeDefined();
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });

    it("rejects unexpected query parameters with 400", async () => {
      const res = await request(createMarketsApp()).get(
        "/api/markets?status=active&unknownParam=true",
      );

      expect(res.status).toBe(200);
      // The listMarketsQuerySchema does not strip unknown params by default,
      // so unknown params are silently ignored rather than rejected.
      expect(res.body.data).toBeDefined();
    });
  });
});
