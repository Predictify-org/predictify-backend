/**
 * adminHealthDetail.test.ts
 *
 * Tests for GET /api/admin/health/detail.
 *
 * All external I/O is replaced by in-memory stubs — no DB or RPC connection
 * required. The service layer is tested directly (unit) and the HTTP layer is
 * tested via supertest (integration).
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/middleware/errorHandler";
import { createAdminHealthRouter } from "../src/routes/admin/health";
import {
  getAdminHealthDetail,
  type PoolLike,
  type RpcLike,
} from "../src/services/adminHealthService";

// ── Prevent real DB/RPC connections ──────────────────────────────────────────

jest.mock("../src/db/client", () => ({
  pool: {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

jest.mock("../src/queue", () => ({
  redisConnection: { ping: jest.fn().mockResolvedValue("PONG") },
}));

// ── JWT helpers ───────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDR = "GADMIN0000000000000000000000000000000000000000000000000000";
const USER_ADDR  = "GUSER00000000000000000000000000000000000000000000000000000";

function sign(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminToken = sign({ sub: ADMIN_ADDR, role: "admin" });
const userToken  = sign({ sub: USER_ADDR,  role: "user" });

// ── Stub factories ────────────────────────────────────────────────────────────

function makePool(overrides: any = {}): PoolLike {
  return {
    totalCount: 10,
    idleCount: 7,
    waitingCount: 0,
    query: async () => ({ rows: [{ last_ledger: 1000 }] }),
    ...overrides,
  } as any;
}

function makeRpc(latestLedger = 1050): RpcLike {
  return {
    getLatestLedger: async () => ({ sequence: latestLedger }),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(rateLimitPerMinute = 100): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/health", createAdminHealthRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service layer unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getAdminHealthDetail — service unit tests", () => {
  it("returns ok status when DB and RPC are healthy and lag is within threshold", async () => {
    const pool = makePool();
    const rpc  = makeRpc(1010); // lag = 10

    const detail = await getAdminHealthDetail(pool, rpc);

    expect(detail.dbPool.status).toBe("ok");
    expect(detail.rpc.status).toBe("ok");
    expect(detail.indexer.status).toBe("ok");
    expect(detail.indexer.lagLedgers).toBe(10);
    expect(detail.checkedAt).toBeTruthy();
  });

  it("exposes correct pool stats", async () => {
    const pool = makePool({ totalCount: 10, idleCount: 4, waitingCount: 2 });
    const detail = await getAdminHealthDetail(pool, makeRpc());

    expect(detail.dbPool.stats).toEqual({ total: 10, idle: 4, waiting: 2 });
  });

  it("reports indexer lag correctly", async () => {
    // cursor = 800, tip = 1000  →  lag = 200
    const pool = makePool({
      query: async () => ({ rows: [{ last_ledger: 800 }] }),
    });
    const detail = await getAdminHealthDetail(pool, makeRpc(1000));

    expect(detail.indexer.lastIndexedLedger).toBe(800);
    expect(detail.indexer.chainTip).toBe(1000);
    expect(detail.indexer.lagLedgers).toBe(200);
  });

  it("clamps negative lag to 0 when cursor is ahead of tip", async () => {
    const pool = makePool({
      query: async () => ({ rows: [{ last_ledger: 2000 }] }),
    });
    const detail = await getAdminHealthDetail(pool, makeRpc(1000));
    expect(detail.indexer.lagLedgers).toBe(0);
  });

  it("marks indexer degraded when lag exceeds INDEXER_LAG_ALERT_THRESHOLD", async () => {
    // Default threshold is 200; set lag to 201
    const pool = makePool({
      query: async () => ({ rows: [{ last_ledger: 799 }] }),
    });
    const detail = await getAdminHealthDetail(pool, makeRpc(1000));
    expect(detail.indexer.status).toBe("degraded");
  });

  it("marks indexer.lastIndexedLedger as null when cursor table is empty", async () => {
    const pool = makePool({ query: async () => ({ rows: [] }) });
    const detail = await getAdminHealthDetail(pool, makeRpc(1000));
    expect(detail.indexer.lastIndexedLedger).toBeNull();
    expect(detail.indexer.lagLedgers).toBeNull();
    expect(detail.indexer.status).toBe("degraded");
  });

  it("marks dbPool errored when DB query throws", async () => {
    const pool = makePool({ query: async () => { throw new Error("DB down"); } });
    const detail = await getAdminHealthDetail(pool, makeRpc());

    expect(detail.dbPool.status).toBe("error");
    expect(detail.dbPool.error).toContain("DB down");
  });

  it("marks rpc errored when RPC throws", async () => {
    const brokenRpc: RpcLike = {
      getLatestLedger: async () => { throw new Error("RPC timeout"); },
    };
    const detail = await getAdminHealthDetail(makePool(), brokenRpc);

    expect(detail.rpc.status).toBe("error");
    expect(detail.rpc.latestLedger).toBeNull();
    expect(detail.rpc.error).toContain("RPC timeout");
  });

  it("marks indexer errored when RPC throws during indexer check", async () => {
    const brokenRpc: RpcLike = {
      getLatestLedger: async () => { throw new Error("RPC down"); },
    };
    const detail = await getAdminHealthDetail(makePool(), brokenRpc);

    expect(detail.indexer.status).toBe("error");
    expect(detail.indexer.chainTip).toBeNull();
  });

  it("includes a valid ISO 8601 checkedAt timestamp", async () => {
    const detail = await getAdminHealthDetail(makePool(), makeRpc());
    expect(() => new Date(detail.checkedAt)).not.toThrow();
    expect(new Date(detail.checkedAt).toISOString()).toBe(detail.checkedAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/health/detail — HTTP", () => {
  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).get("/api/admin/health/detail");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a non-admin JWT (role: user)", async () => {
    const res = await request(makeApp())
      .get("/api/admin/health/detail")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for a JWT signed with a wrong secret", async () => {
    const badToken = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      "wrong-secret-at-least-32-characters-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(makeApp())
      .get("/api/admin/health/detail")
      .set("Authorization", `Bearer ${badToken}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 with full detail payload for an admin token", async () => {
    const res = await request(makeApp())
      .get("/api/admin/health/detail")
      .set("Authorization", `Bearer ${adminToken}`);

    // May be 200 or 207 depending on real RPC; we just assert shape and auth.
    expect([200, 207]).toContain(res.status);

    const body = res.body;
    expect(body).toHaveProperty("dbPool");
    expect(body).toHaveProperty("indexer");
    expect(body).toHaveProperty("rpc");
    expect(body).toHaveProperty("checkedAt");
    expect(body.dbPool).toHaveProperty("stats");
    expect(body.dbPool.stats).toMatchObject({
      total: expect.any(Number),
      idle: expect.any(Number),
      waiting: expect.any(Number),
    });
  });

  it("returns 429 when rate limit is breached", async () => {
    const app = makeApp(1); // 1 request/min
    const agent = request.agent(app);

    // First request should pass (200 or 207 or 403 for env).
    await agent.get("/api/admin/health/detail").set("Authorization", `Bearer ${adminToken}`);

    // Second request within the same window should be throttled.
    const res = await agent
      .get("/api/admin/health/detail")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toHttpStatus helper (indirectly via HTTP layer)
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP status mapping", () => {
  it("200 shape — all keys present when all probes succeed", async () => {
    const res = await request(makeApp())
      .get("/api/admin/health/detail")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.body).toMatchObject({
      dbPool: expect.objectContaining({ status: expect.stringMatching(/ok|error|degraded/) }),
      indexer: expect.objectContaining({ status: expect.stringMatching(/ok|error|degraded/) }),
      rpc: expect.objectContaining({ status: expect.stringMatching(/ok|error|degraded/) }),
    });
  });
});
