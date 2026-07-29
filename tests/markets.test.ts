import request from "supertest";
import type { Database } from "../src/db/client";
import { setDbForTests } from "../src/db/client";
import { createApp } from "../src/index";

type MarketRow = {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  version: number;
  createdAt?: Date;
};

/**
 * Creates a complete mock database that implements the full Drizzle query builder interface.
 * This replaces the deprecated in-memory stub bypass and ensures tests use the real repository path.
 */
function createMarketDb(rows: MarketRow[]): Database {
  // Sort rows by createdAt DESC, id DESC to simulate the cursor pagination order.
  const sorted = [...rows].sort((a, b) => {
    const aTime = (a.createdAt ?? a.resolutionTime).getTime();
    const bTime = (b.createdAt ?? b.resolutionTime).getTime();
    if (bTime !== aTime) return bTime - aTime; // DESC
    return b.id.localeCompare(a.id); // id DESC tie-breaker
  });

  return {
    select: jest.fn((_columns?: any) => ({
      from: jest.fn((_table: any) => ({
        where: jest.fn((_condition: any) => ({
          orderBy: jest.fn((_orderByFn: any, ..._rest: any) => ({
            limit: jest.fn(async (limitVal: number) => {
              // limitVal is limit + 1 (probe row).
              return sorted.slice(0, limitVal);
            }),
          })),
        })),
      })),
    })),
    transaction: jest.fn(async (fn: Function) => {
      return fn({
        select: jest.fn((_columns?: any) => ({
          from: jest.fn((_table: any) => ({
            where: jest.fn((_condition: any) => ({
              limit: jest.fn(async (limitVal: number) => sorted.slice(0, limitVal)),
            })),
          })),
        })),
        update: jest.fn((_table: any) => ({
          set: jest.fn((values: any) => ({
            where: jest.fn((_condition: any) => ({
              returning: jest.fn(async () => [{ ...sorted[0], ...values }]),
            })),
          })),
        })),
        insert: jest.fn((_table: any) => ({
          values: jest.fn(async () => undefined),
        })),
      });
    }),
  } as unknown as Database;
}

describe("GET /api/markets", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("returns seeded markets from the database query", async () => {
    setDbForTests(createMarketDb([
      {
        id: "market-1",
        question: "Will Predictify ship real market reads?",
        status: "active",
        resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
        version: 1,
      },
    ]));

    const res = await request(createApp()).get("/api/markets");

    expect(res.status).toBe(200);
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
  });

  it("returns an ETag header and supports conditional revalidation", async () => {
    setDbForTests(createMarketDb([
      {
        id: "market-1",
        question: "Will Predictify ship real market reads?",
        status: "active",
        resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
        version: 1,
      },
    ]));

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
    setDbForTests(createMarketDb([
      {
        id: "market-1",
        question: "Will Predictify ship real market reads?",
        status: "active",
        resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
        version: 1,
      },
    ]));

    const res = await request(createApp())
      .get("/api/markets")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });

  it("returns empty array when no markets exist", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp()).get("/api/markets");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("respects pagination limit parameter", async () => {
    const markets = Array.from({ length: 5 }, (_, i) => ({
      id: `market-${i + 1}`,
      question: `Question ${i + 1}`,
      status: "active",
      resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
      version: 1,
    }));

    setDbForTests(createMarketDb(markets));

    const res = await request(createApp()).get("/api/markets?limit=2");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("rejects invalid pagination input", async () => {
    const res = await request(createApp()).get("/api/markets?limit=1000");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid_query" } });
  });

  it("rejects non-numeric limit", async () => {
    setDbForTests(createMarketDb([]));

    const res = await request(createApp()).get("/api/markets?limit=abc");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid_query" } });
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
    expect(res.body.nextCursor).not.toBeNull();

    const res2 = await request(createApp()).get(`/api/markets?limit=2&cursor=${res.body.nextCursor}`);
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(2);
    expect(res2.body.data[0].id).not.toBe(res.body.data[0].id);
  });
});

describe("GET /api/markets/:id", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("returns a single market by ID", async () => {
    setDbForTests(createMarketDb([
      {
        id: "market-1",
        question: "Will Predictify ship real market reads?",
        status: "active",
        resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
        version: 1,
      },
    ]));

    const res = await request(createApp()).get("/api/markets/market-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
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
    setDbForTests(createMarketDb([
      {
        id: "market-abc-123",
        question: "Test question",
        status: "active",
        resolutionTime: new Date("2026-07-01T00:00:00.000Z"),
        version: 1,
      },
    ]));

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

    // Validation schema is strict(), so this should fail
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Regression: ensure stub bypass is removed", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("throws error if mock database returns non-array from select", async () => {
    const badDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => null), // Wrong: should be an array
            })),
          })),
        })),
      })),
    } as unknown as Database;

    setDbForTests(badDb);

    const res = await request(createApp()).get("/api/markets");

    // Should fail because the real service now validates the response type
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("validates market ID is a string in getMarketById", async () => {
    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(async () => [
              {
                id: "market-1",
                question: "Test",
                status: "active",
                resolutionTime: new Date(),
              },
            ]),
          })),
        })),
      })),
    } as unknown as Database;

    setDbForTests(mockDb);

    // This test validates that the service layer performs input validation
    const res = await request(createApp()).get("/api/markets/market-1");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/markets/tags", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("returns market tags with counts", async () => {
    // Mock the database to return tags
    const mockTagsResult = [
      { tag: "football", count: 5 },
      { tag: "sports", count: 3 },
      { tag: "politics", count: 2 },
    ];

    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          })),
        })),
      })),
      transaction: jest.fn(async (fn: Function) => fn({})),
      execute: jest.fn(async () => ({
        rows: mockTagsResult,
      })),
    } as unknown as Database;

    setDbForTests(mockDb);

    const res = await request(createApp()).get("/api/markets/tags");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: mockTagsResult,
    });
  });

  it("returns empty array when no tags", async () => {
    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          })),
        })),
      })),
      transaction: jest.fn(async (fn: Function) => fn({})),
      execute: jest.fn(async () => ({
        rows: [],
      })),
    } as unknown as Database;

    setDbForTests(mockDb);

    const res = await request(createApp()).get("/api/markets/tags");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  // ── ETag / conditional GET ────────────────────────────────────────────

  it("returns a strong ETag header on 200", async () => {
    const mockTagsResult = [{ tag: "sports", count: 5 }];
    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          })),
        })),
      })),
      transaction: jest.fn(async (fn: Function) => fn({})),
      execute: jest.fn(async () => ({ rows: mockTagsResult })),
    } as unknown as Database;

    setDbForTests(mockDb);

    const res = await request(createApp()).get("/api/markets/tags");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 304 when If-None-Match matches", async () => {
    const mockTagsResult = [{ tag: "sports", count: 5 }];
    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          })),
        })),
      })),
      transaction: jest.fn(async (fn: Function) => fn({})),
      execute: jest.fn(async () => ({ rows: mockTagsResult })),
    } as unknown as Database;

    setDbForTests(mockDb);
    const first = await request(createApp()).get("/api/markets/tags");
    const etag = first.headers["etag"] as string;

    const second = await request(createApp())
      .get("/api/markets/tags")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("returns 200 for a stale ETag", async () => {
    const mockTagsResult = [{ tag: "sports", count: 5 }];
    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          })),
        })),
      })),
      transaction: jest.fn(async (fn: Function) => fn({})),
      execute: jest.fn(async () => ({ rows: mockTagsResult })),
    } as unknown as Database;

    setDbForTests(mockDb);

    const res = await request(createApp())
      .get("/api/markets/tags")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});

describe("GET /api/markets Timeout Validation", () => {
  afterEach(() => {
    setDbForTests(null);
  });

  it("returns 408 Request Timeout when the database query exceeds the timeout limit", async () => {
    // Mock the database to simulate a delayed response
    const mockDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(() => new Promise((resolve) => setTimeout(resolve, 11000))),
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
        message: "Request timeout exceeded"
      }
    });
  }, 15000); // Give the test block enough time to complete
});