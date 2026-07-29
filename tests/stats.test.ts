/**
 * tests/stats.test.ts
 *
 * Focused tests for ETag support on GET /api/stats.
 *
 * Coverage matrix
 * ─────────────────────────────────────────────────────────
 * Unit – generateETag (imported from middleware)
 *   ✓ returns a quoted SHA-256 hex string
 *
 * Integration – GET /api/stats via supertest
 *   ✓ 200 response includes ETag header
 *   ✓ 200 response includes Cache-Control: no-cache
 *   ✓ 200 response has correct data shape
 *   ✓ 304 when If-None-Match matches current ETag
 *   ✓ 304 has no body
 *   ✓ 304 still includes ETag header
 *   ✓ 304 with unquoted (bare hash) If-None-Match
 *   ✓ 200 when If-None-Match is stale
 *   ✓ 200 when If-None-Match header is absent
 *   ✓ ETag is stable across repeated requests
 *   ✓ ETag changes when data changes
 *   ✓ sending old ETag after data change returns 200
 *   ✓ 500 with error envelope when service throws
 */

import request from "supertest";
import { generateETag } from "../src/middleware/etag";
import { createApp } from "../src/index";
import * as statsService from "../src/services/statsService";

jest.mock("../src/services/statsService");

const mockGetGlobalStats =
  statsService.getGlobalStats as jest.MockedFunction<
    typeof statsService.getGlobalStats
  >;

const app = createApp();

const baseStats = {
  users: 100,
  markets: { total: 10, active: 5, resolved: 5 },
  predictions: 1000,
  claims: 50,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGlobalStats.mockResolvedValue(baseStats);
});

// ---------------------------------------------------------------------------
// Unit tests – ETag generation on the stats payload shape
// ---------------------------------------------------------------------------

describe("generateETag (unit, stats payload)", () => {
  it("returns a quoted SHA-256 hex string for a stats payload", () => {
    const etag = generateETag({ data: baseStats });
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests – GET /api/stats
// ---------------------------------------------------------------------------

describe("GET /api/stats – ETag integration", () => {
  // ── 200 happy path ────────────────────────────────────────────────────────

  it("200 response includes an ETag header", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("200 response includes Cache-Control: no-cache", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("200 response has the correct data shape", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      users: 100,
      markets: { total: 10, active: 5, resolved: 5 },
      predictions: 1000,
      claims: 50,
    });
  });

  // ── Conditional GET: 304 ─────────────────────────────────────────────────

  it("returns 304 when If-None-Match matches current ETag", async () => {
    const first = await request(app).get("/api/stats");
    const etag = first.headers["etag"];
    expect(etag).toBeDefined();

    const second = await request(app)
      .get("/api/stats")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
  });

  it("304 response has no body", async () => {
    const first = await request(app).get("/api/stats");
    const etag = first.headers["etag"];

    const second = await request(app)
      .get("/api/stats")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    const bodyText = second.text;
    expect(bodyText).toBeFalsy();
  });

  it("304 response still includes ETag header", async () => {
    const first = await request(app).get("/api/stats");
    const etag = first.headers["etag"];

    const second = await request(app)
      .get("/api/stats")
      .set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.headers["etag"]).toBe(etag);
  });

  it("304 with unquoted (bare hash) If-None-Match", async () => {
    const first = await request(app).get("/api/stats");
    const quotedEtag = first.headers["etag"];
    const bareHash = quotedEtag.replace(/"/g, "");

    const second = await request(app)
      .get("/api/stats")
      .set("If-None-Match", bareHash);

    expect(second.status).toBe(304);
  });

  // ── Conditional GET: stale / absent ──────────────────────────────────────

  it("returns 200 when If-None-Match is stale", async () => {
    const res = await request(app)
      .get("/api/stats")
      .set(
        "If-None-Match",
        '"000000000000000000000000000000000000000000000000000000000000dead"',
      );

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("returns 200 when If-None-Match header is absent", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
  });

  // ── ETag correctness ─────────────────────────────────────────────────────

  it("ETag is stable across repeated requests for the same data", async () => {
    const r1 = await request(app).get("/api/stats");
    const r2 = await request(app).get("/api/stats");

    expect(r1.headers["etag"]).toBe(r2.headers["etag"]);
  });

  it("ETag changes when the stats data changes", async () => {
    const r1 = await request(app).get("/api/stats");
    const etag1 = r1.headers["etag"];

    // Change the mocked stats
    mockGetGlobalStats.mockResolvedValue({
      ...baseStats,
      users: 200,
      predictions: 2000,
    });

    const r2 = await request(app).get("/api/stats");
    const etag2 = r2.headers["etag"];

    expect(etag1).not.toBe(etag2);
  });

  it("sending old ETag after data change returns 200 (not 304)", async () => {
    const first = await request(app).get("/api/stats");
    const staleEtag = first.headers["etag"];

    // Change the mocked stats
    mockGetGlobalStats.mockResolvedValue({
      ...baseStats,
      users: 999,
    });

    const second = await request(app)
      .get("/api/stats")
      .set("If-None-Match", staleEtag);

    expect(second.status).toBe(200);
    expect(second.body.data.users).toBe(999);
  });

  // ── Error propagation ────────────────────────────────────────────────────

  it("returns 500 with error envelope when service throws", async () => {
    mockGetGlobalStats.mockRejectedValue(new Error("DB connection lost"));

    const res = await request(app).get("/api/stats");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBeDefined();
  });
});
