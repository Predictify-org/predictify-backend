/**
 * tests/etag.test.ts
 *
 * Focused tests for ETag support on GET /api/markets/:id.
 *
 * Coverage matrix
 * ─────────────────────────────────────────────────────────
 * Unit – generateETag
 *   ✓ returns a quoted SHA-256 hex string
 *   ✓ same payload → same ETag (deterministic)
 *   ✓ different payload → different ETag
 *   ✓ field insertion order does not matter (sorted keys)
 *   ✓ handles arrays, primitives, null, nested objects
 *
 * Unit – conditionalGet
 *   ✓ sets ETag header on every response
 *   ✓ sets Cache-Control: no-cache on every response
 *   ✓ returns false (no 304) when If-None-Match is absent
 *   ✓ returns true and sends 304 when If-None-Match matches (quoted)
 *   ✓ returns true and sends 304 when If-None-Match matches (unquoted hash)
 *   ✓ returns false when If-None-Match does not match
 *   ✓ ignores stale If-None-Match values
 *
 * Integration – GET /api/markets/:id via supertest
 *   ✓ 200 response includes ETag header
 *   ✓ 200 response includes Cache-Control: no-cache
 *   ✓ 304 when If-None-Match matches current ETag
 *   ✓ 304 has no body
 *   ✓ 200 when If-None-Match is stale
 *   ✓ 200 when If-None-Match header is absent
 *   ✓ 404 does NOT include ETag header
 *   ✓ ETag changes after version bump (different version → different hash)
 *   ✓ ETag is stable across repeated requests for same market state
 */

import request from "supertest";
import type { Request, Response } from "express";
import { generateETag, conditionalGet } from "../src/middleware/etag";
import { setDbForTests } from "../src/db/client";
import type { Database } from "../src/db/client";
import { createApp } from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MarketRow = {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  version: number;
};

/**
 * Builds the minimal Drizzle mock that the marketService select chain needs.
 * The mock returns `rows` for any `.where(...).limit(n)` call.
 */
function createMockDb(rows: MarketRow[]): Database {
  return {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({
              offset: jest.fn(async (off: number) => rows.slice(off)),
            })),
          })),
          limit: jest.fn(async (n: number) => rows.slice(0, n)),
        })),
      })),
    })),
    transaction: jest.fn(),
  } as unknown as Database;
}

/** Builds a minimal mock Express req/res pair for unit tests. */
function mockReqRes(
  headers: Record<string, string> = {},
): { req: Partial<Request>; res: Partial<Response>; headers: Record<string, string>; statusCode: number | null } {
  const responseHeaders: Record<string, string> = {};
  let statusCode: number | null = null;

  const res: Partial<Response> = {
    setHeader: jest.fn((name: string, value: string) => {
      responseHeaders[name.toLowerCase()] = value;
      return res as Response;
    }),
    status: jest.fn((code: number) => {
      statusCode = code;
      return res as Response;
    }),
    end: jest.fn(),
  };

  const req: Partial<Request> = {
    id: "test-req-id",
    path: "/api/markets/market-1",
    headers: headers as Record<string, string>,
  } as Partial<Request> & { id: string };

  return { req, res, headers: responseHeaders, statusCode: statusCode as any };
}

// ---------------------------------------------------------------------------
// Unit tests – generateETag
// ---------------------------------------------------------------------------

describe("generateETag", () => {
  it("returns a quoted SHA-256 hex string", () => {
    const etag = generateETag({ id: "m1", version: 1 });
    // Must be a 64-char hex hash surrounded by double quotes
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("is deterministic — same payload produces the same ETag", () => {
    const payload = { id: "m1", question: "Will it ship?", version: 3 };
    expect(generateETag(payload)).toBe(generateETag(payload));
  });

  it("produces different ETags for different payloads", () => {
    const a = generateETag({ id: "m1", version: 1 });
    const b = generateETag({ id: "m1", version: 2 });
    expect(a).not.toBe(b);
  });

  it("is insensitive to field insertion order", () => {
    const a = generateETag({ id: "m1", question: "Q", version: 1 });
    const b = generateETag({ version: 1, question: "Q", id: "m1" });
    expect(a).toBe(b);
  });

  it("handles arrays in payload (order matters inside arrays)", () => {
    const a = generateETag(["alpha", "beta"]);
    const b = generateETag(["beta", "alpha"]);
    expect(a).not.toBe(b);
  });

  it("handles null, number, and string primitives", () => {
    expect(generateETag(null)).toMatch(/^"[0-9a-f]{64}"$/);
    expect(generateETag(42)).toMatch(/^"[0-9a-f]{64}"$/);
    expect(generateETag("hello")).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("handles deeply nested objects deterministically", () => {
    const deep = { a: { c: 3, b: 2 }, z: [1, 2] };
    const deep2 = { z: [1, 2], a: { b: 2, c: 3 } };
    expect(generateETag(deep)).toBe(generateETag(deep2));
  });
});

// ---------------------------------------------------------------------------
// Unit tests – conditionalGet
// ---------------------------------------------------------------------------

describe("conditionalGet", () => {
  const market = { id: "m1", question: "Test?", status: "active", version: 1 };
  const etag = generateETag(market); // e.g. `"abc123..."`
  const rawHash = etag.slice(1, -1); // strip quotes

  it("sets ETag header on every call", () => {
    const { req, res, headers } = mockReqRes();
    conditionalGet(market, req as Request, res as Response);
    expect(headers["etag"]).toBe(etag);
  });

  it("sets Cache-Control: no-cache on every call", () => {
    const { req, res, headers } = mockReqRes();
    conditionalGet(market, req as Request, res as Response);
    expect(headers["cache-control"]).toBe("no-cache");
  });

  it("returns false when If-None-Match header is absent", () => {
    const { req, res } = mockReqRes();
    const result = conditionalGet(market, req as Request, res as Response);
    expect(result).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns true and sends 304 when If-None-Match matches (quoted ETag)", () => {
    const { req, res } = mockReqRes({ "if-none-match": etag });
    const result = conditionalGet(market, req as Request, res as Response);
    expect(result).toBe(true);
    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.end).toHaveBeenCalled();
  });

  it("returns true and sends 304 when If-None-Match matches (bare hash)", () => {
    // Some HTTP clients send the raw hash without quotes — handle defensively.
    const { req, res } = mockReqRes({ "if-none-match": rawHash });
    const result = conditionalGet(market, req as Request, res as Response);
    expect(result).toBe(true);
    expect(res.status).toHaveBeenCalledWith(304);
  });

  it("returns false when If-None-Match does not match", () => {
    const { req, res } = mockReqRes({ "if-none-match": '"stale-hash-value"' });
    const result = conditionalGet(market, req as Request, res as Response);
    expect(result).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns false when If-None-Match is an unrelated string", () => {
    const { req, res } = mockReqRes({ "if-none-match": '"not-a-real-hash"' });
    const result = conditionalGet(market, req as Request, res as Response);
    expect(result).toBe(false);
  });

  it("does not send 304 for a different version of the same market", () => {
    const updated = { ...market, version: 2 };
    const oldEtag = generateETag(market);
    const { req, res } = mockReqRes({ "if-none-match": oldEtag });
    const result = conditionalGet(updated, req as Request, res as Response);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests – GET /api/markets/:id
// ---------------------------------------------------------------------------

describe("GET /api/markets/:id – ETag integration", () => {
  const marketRow: MarketRow = {
    id: "market-etag-1",
    question: "Will ETags ship?",
    status: "active",
    resolutionTime: new Date("2026-12-01T00:00:00.000Z"),
    version: 1,
  };

  /** GET helper pre-configured with the allowed CORS origin. */
  const get = (url: string) => request(createApp()).get(url).set("Origin", "http://localhost:5173");

  afterEach(() => {
    setDbForTests(null);
  });

  // ── 200 happy path ────────────────────────────────────────────────────────

  it("200 response includes an ETag header", async () => {
    setDbForTests(createMockDb([marketRow]));
    const res = await get("/api/markets/market-etag-1");

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("200 response includes Cache-Control: no-cache", async () => {
    setDbForTests(createMockDb([marketRow]));
    const res = await get("/api/markets/market-etag-1");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("200 body contains the full market payload", async () => {
    setDbForTests(createMockDb([marketRow]));
    const res = await get("/api/markets/market-etag-1");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: "market-etag-1",
      question: "Will ETags ship?",
      status: "active",
      version: 1,
    });
  });

  // ── Conditional GET: 304 ─────────────────────────────────────────────────

  it("returns 304 when If-None-Match matches current ETag", async () => {
    // First fetch to get the current ETag.
    setDbForTests(createMockDb([marketRow]));
    const first = await get("/api/markets/market-etag-1");
    const etag = first.headers["etag"];
    expect(etag).toBeDefined();

    // Second fetch with matching ETag.
    setDbForTests(createMockDb([marketRow]));
    const second = await get("/api/markets/market-etag-1")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("304 response has no body", async () => {
    setDbForTests(createMockDb([marketRow]));
    const first = await get("/api/markets/market-etag-1");
    const etag = first.headers["etag"];

    setDbForTests(createMockDb([marketRow]));
    const second = await get("/api/markets/market-etag-1")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    // supertest exposes the body as empty string or empty object on 304
    const bodyText = second.text;
    expect(bodyText).toBeFalsy();
  });

  it("304 response still includes ETag header", async () => {
    setDbForTests(createMockDb([marketRow]));
    const first = await get("/api/markets/market-etag-1");
    const etag = first.headers["etag"];

    setDbForTests(createMockDb([marketRow]));
    const second = await get("/api/markets/market-etag-1")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.headers["etag"]).toBe(etag);
  });

  // ── Conditional GET: stale / absent ──────────────────────────────────────

  it("returns 200 when If-None-Match is stale (wrong hash)", async () => {
    setDbForTests(createMockDb([marketRow]));
    const res = await get("/api/markets/market-etag-1")
      .set("If-None-Match", '"000000000000000000000000000000000000000000000000000000000000dead"');

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("returns 200 when If-None-Match header is absent", async () => {
    setDbForTests(createMockDb([marketRow]));
    const res = await get("/api/markets/market-etag-1");
    expect(res.status).toBe(200);
  });

  // ── ETag correctness ─────────────────────────────────────────────────────

  it("ETag is stable across repeated requests for the same market state", async () => {
    setDbForTests(createMockDb([marketRow]));
    const r1 = await get("/api/markets/market-etag-1");

    setDbForTests(createMockDb([marketRow]));
    const r2 = await get("/api/markets/market-etag-1");

    expect(r1.headers["etag"]).toBe(r2.headers["etag"]);
  });

  it("ETag changes when the market version increments", async () => {
    setDbForTests(createMockDb([marketRow]));
    const r1 = await get("/api/markets/market-etag-1");
    const etag1 = r1.headers["etag"];

    const updatedRow = { ...marketRow, version: 2 };
    setDbForTests(createMockDb([updatedRow]));
    const r2 = await get("/api/markets/market-etag-1");
    const etag2 = r2.headers["etag"];

    expect(etag1).not.toBe(etag2);
  });

  it("sending old ETag after version bump returns 200 (not 304)", async () => {
    setDbForTests(createMockDb([marketRow]));
    const first = await get("/api/markets/market-etag-1");
    const staleEtag = first.headers["etag"];

    // Market bumped to version 2
    const updatedRow = { ...marketRow, version: 2 };
    setDbForTests(createMockDb([updatedRow]));
    const second = await get("/api/markets/market-etag-1")
      .set("If-None-Match", staleEtag);

    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(2);
  });

  // ── 404 – no ETag ────────────────────────────────────────────────────────

  it("404 response does NOT include an ETag header", async () => {
    setDbForTests(createMockDb([])); // empty — market not found
    const res = await get("/api/markets/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["etag"]).toBeUndefined();
  });

  it("404 still follows the standard error envelope", async () => {
    setDbForTests(createMockDb([]));
    const res = await get("/api/markets/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("not_found");
  });
});
