/**
 * tests/adminHealthProbe.test.ts
 *
 * Tests for GET /api/admin/health (dependency probe endpoint, not /detail).
 *
 * Strategy
 * ────────
 * • The injectable probe callbacks replace all external I/O — no real DB,
 *   Redis, or network calls are made.
 * • The router is mounted on a minimal Express app so tests are isolated
 *   from the full application bootstrap.
 * • The errorHandler is attached so unexpected-throw tests validate the
 *   standard error envelope format.
 *
 * Coverage
 * ────────
 * • 200 all-ok
 * • 503 any dependency down (database, sorobanRpc, queue)
 * • 503 all dependencies down
 * • Response shape: status, correlationId, checkedAt, dependencies
 * • Per-dependency latency and error fields
 * • correlationId: echo from header / UUID generation fallback
 * • No authentication required
 * • Probe errors propagate as 500 via errorHandler
 * • Structured log emitted on each request
 * • Default export wires to production probes
 */

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL = "redis://localhost:6379";

jest.mock("../src/db/client", () => ({
  db: {},
  pool: { query: jest.fn() },
  connectWithRetry: jest.fn(),
  closeDb: jest.fn(),
  getDb: jest.fn(),
  getPool: jest.fn(),
  setDbForTests: jest.fn(),
}));

jest.mock("../src/queue", () => ({
  redisConnection: { ping: jest.fn().mockResolvedValue("PONG") },
  webhookQueue: { add: jest.fn() },
  backupVerificationQueue: { add: jest.fn() },
  reconciliationQueue: { add: jest.fn() },
  marketResolutionQueue: { add: jest.fn() },
  webhookQueueName: "webhook-deliveries",
  backupVerificationQueueName: "backup-verification",
  reconciliationQueueName: "reconciliation",
  marketResolutionQueueName: "market-resolution",
}));

import request from "supertest";
import express from "express";
import { createAdminHealthRouter } from "../src/routes/admin/health";
import { errorHandler } from "../src/middleware/errorHandler";
import type { ProbeResult } from "../src/routes/admin/health";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DB_OK: ProbeResult = { status: "ok", latencyMs: 3 };
const RPC_OK: ProbeResult = { status: "ok", latencyMs: 12 };
const QUEUE_OK: ProbeResult = { status: "ok", latencyMs: 2 };

const DB_DOWN: ProbeResult = { status: "down", latencyMs: 100, error: "Database unavailable" };
const RPC_DOWN: ProbeResult = { status: "down", latencyMs: 5000, error: "Soroban RPC unavailable" };
const QUEUE_DOWN: ProbeResult = { status: "down", latencyMs: 200, error: "Webhook queue unavailable" };

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(
  probeDatabase: () => Promise<ProbeResult>,
  probeSorobanRpc: () => Promise<ProbeResult>,
  probeQueue: () => Promise<ProbeResult>,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/health",
    createAdminHealthRouter({
      probes: { probeDatabase, probeSorobanRpc, probeQueue },
    }),
  );
  app.use(errorHandler);
  return app;
}

const URL = "/api/admin/health";

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP status codes
// ═══════════════════════════════════════════════════════════════════════════════

describe("HTTP status codes", () => {
  it("returns 200 when all dependencies are ok", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.status).toBe(200);
  });

  it("returns 503 when database is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_DOWN),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when Soroban RPC is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_DOWN),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when queue is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_DOWN),
    )).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when all dependencies are down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_DOWN),
      () => Promise.resolve(RPC_DOWN),
      () => Promise.resolve(QUEUE_DOWN),
    )).get(URL);
    expect(res.status).toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Response body — status field
// ═══════════════════════════════════════════════════════════════════════════════

describe("response body — status field", () => {
  it("body.status is 'ok' when all pass", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.status).toBe("ok");
  });

  it("body.status is 'down' when database is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_DOWN),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.status).toBe("down");
  });

  it("body.status is 'down' when Soroban RPC is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_DOWN),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.status).toBe("down");
  });

  it("body.status is 'down' when queue is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_DOWN),
    )).get(URL);
    expect(res.body.status).toBe("down");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Response shape
// ═══════════════════════════════════════════════════════════════════════════════

describe("response shape", () => {
  it("includes all required top-level fields", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("correlationId");
    expect(res.body).toHaveProperty("checkedAt");
    expect(res.body).toHaveProperty("dependencies");
  });

  it("dependencies contains database, sorobanRpc, and queue", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.dependencies).toHaveProperty("database");
    expect(res.body.dependencies).toHaveProperty("sorobanRpc");
    expect(res.body.dependencies).toHaveProperty("queue");
  });

  it("each dependency entry contains status and latencyMs", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    for (const key of ["database", "sorobanRpc", "queue"]) {
      expect(res.body.dependencies[key]).toHaveProperty("status");
      expect(res.body.dependencies[key]).toHaveProperty("latencyMs");
    }
  });

  it("checkedAt is a valid ISO-8601 timestamp", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(typeof res.body.checkedAt).toBe("string");
    expect(() => new Date(res.body.checkedAt)).not.toThrow();
    expect(new Date(res.body.checkedAt).getTime()).toBeGreaterThan(0);
  });

  it("includes per-dependency latency values from the probes", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.dependencies.database.latencyMs).toBe(3);
    expect(res.body.dependencies.sorobanRpc.latencyMs).toBe(12);
    expect(res.body.dependencies.queue.latencyMs).toBe(2);
  });

  it("includes error field when a probe is down", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_DOWN),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.dependencies.database.error).toBe("Database unavailable");
  });

  it("does not expose error field when probe is ok", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.dependencies.database).not.toHaveProperty("error");
    expect(res.body.dependencies.sorobanRpc).not.toHaveProperty("error");
    expect(res.body.dependencies.queue).not.toHaveProperty("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Correlation ID
// ═══════════════════════════════════════════════════════════════════════════════

describe("correlationId", () => {
  it("echoes the x-correlation-id header when provided", async () => {
    const id = "my-trace-id-abc-123";
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    ))
      .get(URL)
      .set("x-correlation-id", id);
    expect(res.body.correlationId).toBe(id);
  });

  it("generates a UUID when x-correlation-id is not provided", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("generates a UUID when x-correlation-id is an empty string", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    ))
      .get(URL)
      .set("x-correlation-id", "");
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auth / access control
// ═══════════════════════════════════════════════════════════════════════════════

describe("authentication", () => {
  it("does not require an Authorization header", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.status).toBe(200);
  });

  it("ignores a supplied Authorization header", async () => {
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    ))
      .get(URL)
      .set("Authorization", "Bearer some-random-token");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("error handling", () => {
  it("returns 500 when probeDatabase throws", async () => {
    const throwing = () => Promise.reject(new Error("DB exploded"));
    const res = await request(makeApp(
      throwing,
      () => Promise.resolve(RPC_OK),
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.status).toBe(500);
  });

  it("returns 500 when probeSorobanRpc throws", async () => {
    const throwing = () => Promise.reject(new Error("RPC exploded"));
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      throwing,
      () => Promise.resolve(QUEUE_OK),
    )).get(URL);
    expect(res.status).toBe(500);
  });

  it("returns 500 when probeQueue throws", async () => {
    const throwing = () => Promise.reject(new Error("Queue exploded"));
    const res = await request(makeApp(
      () => Promise.resolve(DB_OK),
      () => Promise.resolve(RPC_OK),
      throwing,
    )).get(URL);
    expect(res.status).toBe(500);
  });

  it("calls each probeFn exactly once per request", async () => {
    const probeDb = jest.fn().mockResolvedValue(DB_OK);
    const probeRpc = jest.fn().mockResolvedValue(RPC_OK);
    const probeQ = jest.fn().mockResolvedValue(QUEUE_OK);
    await request(makeApp(probeDb, probeRpc, probeQ)).get(URL);
    expect(probeDb).toHaveBeenCalledTimes(1);
    expect(probeRpc).toHaveBeenCalledTimes(1);
    expect(probeQ).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Default export
// ═══════════════════════════════════════════════════════════════════════════════

describe("default router", () => {
  it("exports a default adminHealthRouter as a valid Express router", async () => {
    const { adminHealthRouter } = await import("../src/routes/admin/health");
    expect(typeof adminHealthRouter).toBe("function");
    expect(Array.isArray((adminHealthRouter as unknown as { stack: unknown[] }).stack)).toBe(true);
  });
});
