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

async function seedMarkets(rows: Array<{
  id: string;
  question: string;
  status: string;
  resolutionTime: string;
  archived?: boolean;
  version?: number;
  featured?: boolean;
}>) {
  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO markets (
          id, question, status, resolution_time,
          indexed_ledger, archived, version, featured, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
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
      ],
    );
  }
}

function createSearchApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.headers["origin"]) {
      req.headers["origin"] = "http://localhost:5173";
    }
    next();
  });
  app.use((req, _res, next) => {
    requestContextStorage.run({ requestId: uuidv4() }, next);
  });
  app.use("/api/markets", marketsRouter);
  return app;
}

describe("GET /api/markets/search — integration", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE markets RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("input validation", () => {
    it("returns 400 when q query parameter is missing", async () => {
      const res = await request(createSearchApp()).get("/api/markets/search");

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when q is empty", async () => {
      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=",
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when q exceeds 256 characters", async () => {
      const longQuery = "a".repeat(257);
      const res = await request(createSearchApp()).get(
        `/api/markets/search?q=${longQuery}`,
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when limit is not a number", async () => {
      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=test&limit=abc",
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when limit exceeds 100", async () => {
      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=test&limit=101",
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when offset is negative", async () => {
      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=test&offset=-1",
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when page is zero", async () => {
      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=test&page=0",
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 on unknown query parameters", async () => {
      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=test&unknown=param",
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("includes correlationId in the error envelope", async () => {
      const res = await request(createSearchApp()).get("/api/markets/search");

      expect(res.status).toBe(400);
      expect(res.body.error).toHaveProperty("correlationId");
      expect(typeof res.body.error.correlationId).toBe("string");
    });
  });

  describe("search results", () => {
    it("returns matching markets by question text", async () => {
      await seedMarkets([
        {
          id: "search-rain-1",
          question: "Will it rain in San Francisco?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "search-sun-1",
          question: "Will the sun shine in New York?",
          status: "active",
          resolutionTime: "2026-07-02T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("search-rain-1");
      expect(res.body.total).toBe(1);
    });

    it("is case-insensitive", async () => {
      await seedMarkets([
        {
          id: "search-case-1",
          question: "Will the SUN shine today?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=sun",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("matches multiple search terms", async () => {
      await seedMarkets([
        {
          id: "search-multi-1",
          question: "Will it rain in San Francisco this summer?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=san+francisco+summer",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("returns empty data array when no matches exist", async () => {
      await seedMarkets([
        {
          id: "search-empty-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=nonexistentxyz12345",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("excludes archived markets from search results", async () => {
      await seedMarkets([
        {
          id: "search-arch-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "search-arch-2",
          question: "Will it rain too?",
          status: "archived",
          resolutionTime: "2026-07-02T00:00:00.000Z",
          archived: true,
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("search-arch-1");
    });

    it("handles special characters in query", async () => {
      await seedMarkets([
        {
          id: "search-special-1",
          question: "Will C++ be the language of 2026?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=c%2B%2B",
      );

      expect(res.status).toBe(200);
    });
  });

  describe("pagination", () => {
    it("respects limit parameter and returns the correct count", async () => {
      await seedMarkets([
        {
          id: "paginate-1",
          question: "Will it rain in January?",
          status: "active",
          resolutionTime: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "paginate-2",
          question: "Will it rain in February?",
          status: "active",
          resolutionTime: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "paginate-3",
          question: "Will it rain in March?",
          status: "active",
          resolutionTime: "2026-03-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain&limit=2",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.limit).toBe(2);
    });

    it("honours offset parameter", async () => {
      await seedMarkets([
        {
          id: "offset-1",
          question: "Will it rain in January?",
          status: "active",
          resolutionTime: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "offset-2",
          question: "Will it rain in February?",
          status: "active",
          resolutionTime: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "offset-3",
          question: "Will it rain in March?",
          status: "active",
          resolutionTime: "2026-03-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain&limit=2&offset=2",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("offset-3");
      expect(res.body.offset).toBe(2);
    });

    it("computes page from offset when page not specified", async () => {
      await seedMarkets([
        {
          id: "pcom-1",
          question: "Will it rain in January?",
          status: "active",
          resolutionTime: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "pcom-2",
          question: "Will it rain in February?",
          status: "active",
          resolutionTime: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "pcom-3",
          question: "Will it rain in March?",
          status: "active",
          resolutionTime: "2026-03-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain&limit=2&offset=2",
      );

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(2);
    });

    it("uses page parameter to compute offset", async () => {
      await seedMarkets([
        {
          id: "ppage-1",
          question: "Will it rain in January?",
          status: "active",
          resolutionTime: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "ppage-2",
          question: "Will it rain in February?",
          status: "active",
          resolutionTime: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "ppage-3",
          question: "Will it rain in March?",
          status: "active",
          resolutionTime: "2026-03-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain&limit=2&page=2",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("ppage-3");
      expect(res.body.page).toBe(2);
    });
  });

  describe("response structure", () => {
    it("includes fallback flag in the response body", async () => {
      await seedMarkets([
        {
          id: "resp-fallback-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("fallback");
      expect(typeof res.body.fallback).toBe("boolean");
    });

    it("includes pagination block", async () => {
      await seedMarkets([
        {
          id: "resp-pag-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("pagination");
      expect(res.body.pagination).toMatchObject({
        limit: expect.any(Number),
        offset: expect.any(Number),
        page: expect.any(Number),
        total: expect.any(Number),
        fallback: expect.any(Boolean),
      });
    });

    it("includes meta block", async () => {
      await seedMarkets([
        {
          id: "resp-meta-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("meta");
      expect(res.body.meta).toMatchObject({
        limit: expect.any(Number),
        offset: expect.any(Number),
        page: expect.any(Number),
        total: expect.any(Number),
        fallback: expect.any(Boolean),
      });
    });

    it("returns resolutionTime as ISO string", async () => {
      const resolutionTime = "2026-07-15T12:30:00.000Z";
      await seedMarkets([
        {
          id: "resp-iso-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime,
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.body.data[0].resolutionTime).toBe(resolutionTime);
    });
  });

  describe("response headers", () => {
    it("returns x-request-id header", async () => {
      await seedMarkets([
        {
          id: "hdr-1",
          question: "Will it rain?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ]);

      const res = await request(createSearchApp()).get(
        "/api/markets/search?q=rain",
      );

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(typeof res.headers["x-request-id"]).toBe("string");
    });

    it("returns x-request-id on validation error", async () => {
      const res = await request(createSearchApp()).get("/api/markets/search");

      expect(res.status).toBe(400);
      expect(res.headers["x-request-id"]).toBeDefined();
    });
  });
});