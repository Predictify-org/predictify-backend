/**
 * Tests for market input validation schemas.
 *
 * Covers every exported schema in src/validators/markets.ts:
 *  - listMarketsQuerySchema
 *  - searchMarketsQuerySchema
 *  - featuredMarketsQuerySchema
 *  - upcomingMarketsQuerySchema
 *  - trendingQuerySchema
 *  - marketParamsSchema
 *  - patchMarketBodySchema
 *
 * Tests exercise both happy paths and edge cases (boundary values,
 * strict rejection, type coercion, max-length, empty/whitespace strings).
 */

import {
  listMarketsQuerySchema,
  searchMarketsQuerySchema,
  featuredMarketsQuerySchema,
  upcomingMarketsQuerySchema,
  trendingQuerySchema,
  marketParamsSchema,
  patchMarketBodySchema,
} from "../src/validators/markets";

// ── listMarketsQuerySchema ───────────────────────────────────────────────────

describe("listMarketsQuerySchema", () => {
  it("accepts empty query (all defaults)", () => {
    const result = listMarketsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("applies default limit of 20", () => {
    const result = listMarketsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("accepts valid limit", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: 50 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it("accepts limit of 1 (min boundary)", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts limit of 100 (max boundary)", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects limit below 1", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit above 100", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric limit", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: "abc" });
    expect(result.success).toBe(false);
  });

  it("coerces string limit to number", () => {
    const result = listMarketsQuerySchema.safeParse({ limit: "10" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it("accepts valid cursor", () => {
    const result = listMarketsQuerySchema.safeParse({ cursor: "abc123" });
    expect(result.success).toBe(true);
  });

  it("rejects cursor exceeding max length", () => {
    const result = listMarketsQuerySchema.safeParse({ cursor: "x".repeat(513) });
    expect(result.success).toBe(false);
  });

  it("accepts valid status", () => {
    const result = listMarketsQuerySchema.safeParse({ status: "active" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("trims whitespace from status", () => {
    const result = listMarketsQuerySchema.safeParse({ status: "  active  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("rejects status exceeding max length", () => {
    const result = listMarketsQuerySchema.safeParse({ status: "x".repeat(33) });
    expect(result.success).toBe(false);
  });

  it("accepts valid category", () => {
    const result = listMarketsQuerySchema.safeParse({ category: "sports" });
    expect(result.success).toBe(true);
  });

  it("rejects category exceeding max length", () => {
    const result = listMarketsQuerySchema.safeParse({ category: "x".repeat(65) });
    expect(result.success).toBe(false);
  });

  it("accepts valid tag", () => {
    const result = listMarketsQuerySchema.safeParse({ tag: "football" });
    expect(result.success).toBe(true);
  });

  it("rejects tag exceeding max length", () => {
    const result = listMarketsQuerySchema.safeParse({ tag: "x".repeat(65) });
    expect(result.success).toBe(false);
  });

  it("accepts valid sort", () => {
    const result = listMarketsQuerySchema.safeParse({ sort: "createdAt" });
    expect(result.success).toBe(true);
  });

  it("rejects sort exceeding max length", () => {
    const result = listMarketsQuerySchema.safeParse({ sort: "x".repeat(33) });
    expect(result.success).toBe(false);
  });

  it("accepts valid order", () => {
    expect(listMarketsQuerySchema.safeParse({ order: "asc" }).success).toBe(true);
    expect(listMarketsQuerySchema.safeParse({ order: "desc" }).success).toBe(true);
  });

  it("rejects invalid order", () => {
    expect(listMarketsQuerySchema.safeParse({ order: "random" }).success).toBe(false);
  });

  it("rejects extra/unknown query parameters (strict)", () => {
    const result = listMarketsQuerySchema.safeParse({ unknownField: "value" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe("unrecognized_keys");
    }
  });

  it("rejects multiple extra fields", () => {
    const result = listMarketsQuerySchema.safeParse({
      limit: 10,
      extra1: "a",
      extra2: "b",
    });
    expect(result.success).toBe(false);
  });
});

// ── searchMarketsQuerySchema ─────────────────────────────────────────────────

describe("searchMarketsQuerySchema", () => {
  it("rejects missing q parameter", () => {
    const result = searchMarketsQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty q after trim", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts valid q", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "bitcoin" });
    expect(result.success).toBe(true);
  });

  it("trims whitespace from q", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "  bitcoin  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe("bitcoin");
    }
  });

  it("rejects q exceeding max length", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "x".repeat(257) });
    expect(result.success).toBe(false);
  });

  it("accepts q at max length", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "x".repeat(256) });
    expect(result.success).toBe(true);
  });

  it("applies default limit of 20", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("accepts valid limit and offset", () => {
    const result = searchMarketsQuerySchema.safeParse({
      q: "test",
      limit: 50,
      offset: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
    }
  });

  it("accepts valid page", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "test", page: 3 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
    }
  });

  it("rejects page below 1", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "test", page: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative offset", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "test", offset: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects limit above 100", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "test", limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects extra/unknown query parameters (strict)", () => {
    const result = searchMarketsQuerySchema.safeParse({ q: "test", bad: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe("unrecognized_keys");
    }
  });
});

// ── featuredMarketsQuerySchema ───────────────────────────────────────────────

describe("featuredMarketsQuerySchema", () => {
  it("accepts empty query", () => {
    const result = featuredMarketsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid limit", () => {
    const result = featuredMarketsQuerySchema.safeParse({ limit: 10 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it("accepts limit of 1 (min boundary)", () => {
    expect(featuredMarketsQuerySchema.safeParse({ limit: 1 }).success).toBe(true);
  });

  it("accepts limit of 20 (max boundary)", () => {
    expect(featuredMarketsQuerySchema.safeParse({ limit: 20 }).success).toBe(true);
  });

  it("rejects limit of 0", () => {
    expect(featuredMarketsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects limit above 20", () => {
    expect(featuredMarketsQuerySchema.safeParse({ limit: 21 }).success).toBe(false);
  });

  it("rejects non-numeric limit", () => {
    expect(featuredMarketsQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  it("rejects extra/unknown query parameters (strict)", () => {
    const result = featuredMarketsQuerySchema.safeParse({ extra: "nope" });
    expect(result.success).toBe(false);
  });
});

// ── upcomingMarketsQuerySchema ───────────────────────────────────────────────

describe("upcomingMarketsQuerySchema", () => {
  it("accepts empty query (default limit 50)", () => {
    const result = upcomingMarketsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it("accepts valid limit", () => {
    const result = upcomingMarketsQuerySchema.safeParse({ limit: 25 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it("accepts limit of 1 (min boundary)", () => {
    expect(upcomingMarketsQuerySchema.safeParse({ limit: 1 }).success).toBe(true);
  });

  it("accepts limit of 100 (max boundary)", () => {
    expect(upcomingMarketsQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it("rejects limit of 0", () => {
    expect(upcomingMarketsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects limit above 100", () => {
    expect(upcomingMarketsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("rejects extra/unknown query parameters (strict)", () => {
    const result = upcomingMarketsQuerySchema.safeParse({ extra: "nope" });
    expect(result.success).toBe(false);
  });
});

// ── trendingQuerySchema ──────────────────────────────────────────────────────

describe("trendingQuerySchema", () => {
  it("accepts empty query (defaults: limit=20, offset=0)", () => {
    const result = trendingQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });

  it("accepts valid limit and offset", () => {
    const result = trendingQuerySchema.safeParse({ limit: 50, offset: 10 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
    }
  });

  it("accepts limit of 1 (min boundary)", () => {
    expect(trendingQuerySchema.safeParse({ limit: 1 }).success).toBe(true);
  });

  it("accepts limit of 100 (max boundary)", () => {
    expect(trendingQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it("rejects limit of 0", () => {
    expect(trendingQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects limit above 100", () => {
    expect(trendingQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("rejects negative offset", () => {
    expect(trendingQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it("accepts offset of 0", () => {
    expect(trendingQuerySchema.safeParse({ offset: 0 }).success).toBe(true);
  });

  it("rejects extra/unknown query parameters (strict)", () => {
    const result = trendingQuerySchema.safeParse({ sort: "hot" });
    expect(result.success).toBe(false);
  });
});

// ── marketParamsSchema ───────────────────────────────────────────────────────

describe("marketParamsSchema", () => {
  it("accepts valid market ID", () => {
    const result = marketParamsSchema.safeParse({ id: "market-123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("market-123");
    }
  });

  it("trims whitespace from ID", () => {
    const result = marketParamsSchema.safeParse({ id: "  market-1  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("market-1");
    }
  });

  it("rejects empty ID", () => {
    const result = marketParamsSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only ID", () => {
    const result = marketParamsSchema.safeParse({ id: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects ID exceeding max length", () => {
    const result = marketParamsSchema.safeParse({ id: "x".repeat(256) });
    expect(result.success).toBe(false);
  });

  it("accepts ID at max length", () => {
    const result = marketParamsSchema.safeParse({ id: "x".repeat(255) });
    expect(result.success).toBe(true);
  });

  it("rejects missing ID", () => {
    const result = marketParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-string ID", () => {
    const result = marketParamsSchema.safeParse({ id: 123 });
    expect(result.success).toBe(false);
  });
});

// ── patchMarketBodySchema ────────────────────────────────────────────────────

describe("patchMarketBodySchema", () => {
  it("accepts valid question", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "New question?",
      expectedVersion: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question).toBe("New question?");
    }
  });

  it("trims whitespace from question", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "  New question?  ",
      expectedVersion: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question).toBe("New question?");
    }
  });

  it("rejects empty question after trim", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "   ",
      expectedVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects question exceeding max length", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "x".repeat(513),
      expectedVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts question at max length", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "x".repeat(512),
      expectedVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid metadata", () => {
    const result = patchMarketBodySchema.safeParse({
      metadata: { category: "crypto", tags: ["btc"] },
      expectedVersion: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts body with only expectedVersion", () => {
    const result = patchMarketBodySchema.safeParse({
      expectedVersion: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing expectedVersion", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "Updated?",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer expectedVersion", () => {
    const result = patchMarketBodySchema.safeParse({
      expectedVersion: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative expectedVersion", () => {
    const result = patchMarketBodySchema.safeParse({
      expectedVersion: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric expectedVersion", () => {
    const result = patchMarketBodySchema.safeParse({
      expectedVersion: "not-a-number",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra/unknown fields (strict)", () => {
    const result = patchMarketBodySchema.safeParse({
      question: "Updated?",
      expectedVersion: 1,
      status: "resolved",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe("unrecognized_keys");
    }
  });

  it("rejects empty body", () => {
    const result = patchMarketBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── Schema type exports ──────────────────────────────────────────────────────

describe("exported types", () => {
  it("exports ListMarketsQuery type", () => {
    // Type-level check: this test compiles if the type exists
    const data: import("../src/validators/markets").ListMarketsQuery = {
      limit: 10,
      cursor: undefined,
      status: undefined,
      category: undefined,
      tag: undefined,
      sort: undefined,
      order: undefined,
    };
    expect(data.limit).toBe(10);
  });

  it("exports TrendingQuery type", () => {
    const data: import("../src/validators/markets").TrendingQuery = {
      limit: 20,
      offset: 0,
    };
    expect(data.limit).toBe(20);
  });

  it("exports MarketParams type", () => {
    const data: import("../src/validators/markets").MarketParams = {
      id: "market-1",
    };
    expect(data.id).toBe("market-1");
  });
});
