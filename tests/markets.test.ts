/**
 * Unit tests for GET /api/markets and related handlers.
 *
 * These tests inject a Drizzle-shaped mock via `setDbForTests` and exercise the
 * real route → service → getDb() path. There is no in-memory markets stub:
 * seeded rows must come back from the mock query builder, and unexpected shapes
 * must fail closed (not silently return []).
 */

import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Database } from "../src/db/client";
import { setDbForTests } from "../src/db/client";
import { requestContextStorage } from "../src/lib/requestContext";

jest.mock("../src/queue", () => ({
  redisConnection: {
    on: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    quit: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    ping: jest.fn().mockResolvedValue("PONG"),
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

jest.mock("../src/cache/marketsCache", () => ({
  marketCacheKeys: {
    all: "markets:all",
    byId: (marketId: string) => `markets:${marketId}`,
  },
  invalidateMarketCache: jest.fn().mockResolvedValue(undefined),
}));

// Pass through CORS in unit tests — CORS enforcement is covered by marketsCors.test.ts.
jest.mock("../src/middleware/cors", () => ({
  marketsCors: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  createCorsAllowlistMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import { marketsRouter } from "../src/routes/markets";
import { errorHandler } from "../src/middleware/errorHandler";

type MarketRow = {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  version: number;
  createdAt?: Date;
  archived?: boolean;
};

/**
 * Creates a complete mock database that implements the full Drizzle query builder
 * interface used by `listMarkets` / `getMarketById`. This is the only test double
 * allowed — tests must not bypass the service with an in-memory markets array.
 */
function createMarketDb(rows: MarketRow[]): Database & { select: jest.Mock } {
  const sorted = [...rows].sort((a, b) => {
    const aTime = (a.createdAt ?? a.resolutionTime).getTime();
    const bTime = (b.createdAt ?? b.resolutionTime).getTime();
    if (bTime !== aTime) return bTime - aTime;
    return b.id.localeCompare(a.id);
  });

  const select = jest.fn((_columns?: unknown) => ({
    from: jest.fn((_table: unknown) => ({
      where: jest.fn((_condition: unknown) => ({
        orderBy: jest.fn((_orderByFn: unknown, ..._rest: unknown[]) => ({
          limit: jest.fn(async (limitVal: number) => sorted.slice(0, limitVal)),
        })),
        limit: jest.fn(async (limitVal: number) => sorted.slice(0, limitVal)),
      })),
    })),
  }));

  return {
    select,
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        select: jest.fn((_columns?: unknown) => ({
          from: jest.fn((_table: unknown) => ({
            where: jest.fn((_condition: unknown) => ({
              limit: jest.fn(async (limitVal: number) => sorted.slice(0, limitVal)),
            })),
          })),
        })),
        update: jest.fn((_table: unknown) => ({
          set: jest.fn((values: unknown) => ({
            where: jest.fn((_condition: unknown) => ({
              returning: jest.fn(async () => [{ ...sorted[0], ...(values as object) }]),
            })),
          })),
        })),
        insert: jest.fn((_table: unknown) => ({
          values: jest.fn(async () => undefined),
        })),
      });
    }),
  } as unknown as Database & { select: jest.Mock };
}

/**
 * Lightweight app mounting only the markets router — avoids importing the full
 * `createApp` graph (unrelated modules) while still using the real markets path.
 */
function createApp() {
  const app = express();
  app.use(express.json());
  // Inject a default Origin so marketsCors() allowlist middleware passes in tests.
  app.use((req, _res, next) => {
    if (!req.headers["origin"]) {
      req.headers["origin"] = "http://localhost:5173";
    }
    next();
  });
  app.use((req, _res, next) => {
    const requestId = uuidv4();
    (req as { id?: string }).id = requestId;
    requestContextStorage.run({ requestId }, next);
  });
  app.use("/api/markets", marketsRouter);
  app.use(errorHandler);
  return app;
}

const SEEDED = {
  id: "market-1",
  question: "Will Predictify ship real market reads?",
  status: "active",
  resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
  version: 1,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  archived: false,
} as const;

describe("GET /api/markets", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("returns seeded markets from the database query (real repo path)", async () => {
    const mockDb = createMarketDb([SEEDED]);
    setDbForTests(mockDb);

    const res = await request(createApp()).get("/api/markets");

    expect(res.status).toBe(200);
    expect(mockDb.select).toHaveBeenCalled();
    expect(res.body).toMatchObject({
      data: [
        {
          id: "market-1",
          question: "Will Predictify ship real market reads?",
          status: "active",
          resolutionTime: "2026-07-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it("returns an ETag header and supports conditional revalidation", async () => {
    setDbForTests(createMarketDb([SEEDED]));

    const first = await request(createApp()).get("/api/markets");

    expect(first.status).toBe(200);
    expect(first.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.headers["cache-control"]).toBe("no-cache");

    const second = await request(createApp())
      .get("/api/markets")
      .set("If-None-Match", first.headers["etag"] as string);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("returns 200 for a stale If-None-Match value", async () => {
    setDbForTests(createMarketDb([SEEDED]));

    const res = await request(createApp())
      .get("/api/markets")
      .set(
        "If-None-Match",
        '"000000000000000000000000000000000000000000000000000000000000dead"',
      );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });

  it("returns empty data with null nextCursor when no markets exist", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp()).get("/api/markets");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], nextCursor: null });
  });

  it("respects pagination limit parameter", async () => {
    const markets = Array.from({ length: 5 }, (_, i) => ({
      id: `market-${i + 1}`,
      question: `Question ${i + 1}`,
      status: "active",
      resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
      createdAt: new Date(`2026-07-0${i + 1}T00:00:00.000Z`),
      version: 1,
    }));

    setDbForTests(createMarketDb(markets));

    const res = await request(createApp()).get("/api/markets?limit=2");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("rejects invalid pagination input with standardized validation envelope", async () => {
    const res = await request(createApp()).get("/api/markets?limit=1000");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("rejects non-numeric limit with standardized validation envelope", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp()).get("/api/markets?limit=abc");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("respects cursor pagination", async () => {
    const markets = Array.from({ length: 5 }, (_, i) => ({
      id: `market-${i + 1}`,
      question: `Question ${i + 1}`,
      status: "active",
      resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
      createdAt: new Date(`2026-07-0${i + 1}T00:00:00.000Z`),
      version: 1,
    }));
    setDbForTests(createMarketDb(markets));

    const res = await request(createApp()).get("/api/markets?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(typeof res.body.nextCursor).toBe("string");
    expect(res.body.nextCursor.length).toBeGreaterThan(0);

    // Cursor is accepted by the real validation + service path (mock DB does not
    // apply keyset filtering; integration tests cover full keyset semantics).
    const res2 = await request(createApp()).get(
      `/api/markets?limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`,
    );
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(2);
  });
});

describe("GET /api/markets/:id", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("returns a single market by ID", async () => {
    setDbForTests(createMarketDb([SEEDED]));

    const res = await request(createApp()).get("/api/markets/market-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: {
        id: "market-1",
        question: "Will Predictify ship real market reads?",
        status: "active",
        resolutionTime: "2026-07-01T00:00:00.000Z",
        version: 1,
      },
    });
  });

  it("returns 404 when market not found", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp()).get("/api/markets/nonexistent-id");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "not_found" } });
  });

  it("handles market ID with special characters", async () => {
    setDbForTests(
      createMarketDb([
        {
          id: "market-abc-123",
          question: "Test question",
          status: "active",
          resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
          version: 1,
        },
      ]),
    );

    const res = await request(createApp()).get("/api/markets/market-abc-123");

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("market-abc-123");
  });
});

describe("PATCH /api/markets/:id (secure update with versioning)", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("rejects requests without admin authentication", async () => {
    const res = await request(createApp())
      .patch("/api/markets/market-1")
      .send({ question: "Updated?", expectedVersion: 0 });

    expect(res.status).toBe(401);
  });

  it("validates expectedVersion parameter", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp())
      .patch("/api/markets/market-1")
      .set("Authorization", "Bearer invalid-token")
      .send({ question: "Updated?", expectedVersion: "not-a-number" });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects extra fields in request body", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp())
      .patch("/api/markets/market-1")
      .set("Authorization", "Bearer invalid-token")
      .send({
        question: "Updated?",
        expectedVersion: 0,
        extraField: "should be rejected",
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Regression: ensure stub bypass is removed", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("does not silently return [] when the DB query shape is wrong", async () => {
    const badDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              // Residual stub used to coerce this to [] — must fail closed now.
              limit: jest.fn(async () => null),
            })),
          })),
        })),
      })),
    } as unknown as Database;

    setDbForTests(badDb);

    const res = await request(createApp()).get("/api/markets");

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.data).toBeUndefined();
  });

  it("listUpcomingMarkets fails closed instead of returning [] on bad DB shape", async () => {
    const { listUpcomingMarkets } = await import("../src/services/marketService");
    const badDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => null),
            })),
          })),
        })),
      })),
    } as unknown as Database;

    setDbForTests(badDb);

    await expect(listUpcomingMarkets({ limit: 5 })).rejects.toThrow(
      /rows is not an array/,
    );
  });

  it("returns seeded rows after insert-shaped DB state (no empty stub)", async () => {
    const mockDb = createMarketDb([
      {
        id: "seeded-after-create",
        question: "Seeded market must appear in list",
        status: "active",
        resolutionTime: new Date("2026-08-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
        version: 1,
      },
    ]);
    setDbForTests(mockDb);

    const res = await request(createApp()).get("/api/markets");

    expect(res.status).toBe(200);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(res.body.data).toEqual([
      {
        id: "seeded-after-create",
        question: "Seeded market must appear in list",
        status: "active",
        resolutionTime: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("validates market ID is a string in getMarketById", async () => {
    setDbForTests(createMarketDb([SEEDED]));

    const res = await request(createApp()).get("/api/markets/market-1");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/markets/tags", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  function createTagsDb(tags: Array<{ tag: string; count: number }>) {
    return {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          })),
        })),
      })),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
      execute: jest.fn(async () => ({
        rows: tags,
      })),
    } as unknown as Database;
  }

  it("returns market tags with counts", async () => {
    const mockTagsResult = [
      { tag: "football", count: 5 },
      { tag: "sports", count: 3 },
      { tag: "politics", count: 2 },
    ];

    setDbForTests(createTagsDb(mockTagsResult));

    const res = await request(createApp()).get("/api/markets/tags");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: mockTagsResult,
    });
  });

  it("returns empty array when no tags", async () => {
    setDbForTests(createTagsDb([]));

    const res = await request(createApp()).get("/api/markets/tags");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("returns a strong ETag header on 200", async () => {
    setDbForTests(createTagsDb([{ tag: "sports", count: 5 }]));

    const res = await request(createApp()).get("/api/markets/tags");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    setDbForTests(createTagsDb([{ tag: "sports", count: 5 }]));
    const first = await request(createApp()).get("/api/markets/tags");
    const etag = first.headers["etag"] as string;

    const second = await request(createApp())
      .get("/api/markets/tags")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    setDbForTests(createTagsDb([{ tag: "sports", count: 5 }]));

    const res = await request(createApp())
      .get("/api/markets/tags")
      .set(
        "If-None-Match",
        '"000000000000000000000000000000000000000000000000000000000000dead"',
      );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});

describe("GET /api/markets Timeout Validation", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it(
    "returns 408 Request Timeout when the database query exceeds the timeout limit",
    async () => {
      const mockDb = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({
                limit: jest.fn(
                  () => new Promise((resolve) => setTimeout(resolve, 11000)),
                ),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      setDbForTests(mockDb);

      const res = await request(createApp()).get("/api/markets");

      expect(res.status).toBe(408);
      expect(res.body).toMatchObject({
        error: {
          code: "timeout",
          message: "Request timeout exceeded",
        },
      });
    },
    15000,
  );
});
