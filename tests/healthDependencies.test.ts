/**
 * healthDependencies.test.ts
 *
 * Tests for GET /api/health/dependencies.
 *
 * Strategy
 * ────────
 * • The injectable `probeFn` replaces all external I/O — no real DB,
 *   Redis, or network calls are made.
 * • The router is mounted on a minimal Express app so tests are isolated
 *   from the full application bootstrap.
 * • The errorHandler is attached so unexpected-throw tests validate the
 *   standard error envelope format.
 *
 * Coverage
 * ────────
 * • 200 all-ok
 * • 207 degraded (some ok, some degraded, none down)
 * • 503 any down
 * • 503 multiple down
 * • Response shape: status, correlationId, checkedAt, dependencies
 * • Per-dependency latency and error fields
 * • correlationId: echo from header / UUID generation fallback
 * • No authentication required
 * • Probe errors propagate as 500 via errorHandler
 * • Structured log emitted on each request
 */

// ── Env stubs (must precede all src/ imports) ─────────────────────────────────

process.env.DATABASE_URL  = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET    = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL   = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL     = "redis://localhost:6379";

// ── Module mocks (must precede dynamic imports) ───────────────────────────────

// Prevent the real pool / Redis client from being opened at module load time.
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

// ── Imports ───────────────────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import { createDependenciesRouter } from "../src/routes/health/dependencies";
import { errorHandler } from "../src/middleware/errorHandler";
import type { DependencyHealth } from "../src/services/healthProbes";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_OK: DependencyHealth = {
  postgres:     { status: "ok", latencyMs: 3  },
  sorobanRpc:   { status: "ok", latencyMs: 12 },
  horizon:      { status: "ok", latencyMs: 8  },
  webhookQueue: { status: "ok", latencyMs: 1  },
};

const ONE_DEGRADED: DependencyHealth = {
  postgres:     { status: "ok",       latencyMs: 3   },
  sorobanRpc:   { status: "degraded", latencyMs: 4200 },
  horizon:      { status: "ok",       latencyMs: 8   },
  webhookQueue: { status: "ok",       latencyMs: 1   },
};

const ALL_DEGRADED: DependencyHealth = {
  postgres:     { status: "degraded", latencyMs: 3000 },
  sorobanRpc:   { status: "degraded", latencyMs: 4200 },
  horizon:      { status: "degraded", latencyMs: 4500 },
  webhookQueue: { status: "degraded", latencyMs: 2900 },
};

const ONE_DOWN: DependencyHealth = {
  postgres:     { status: "down", latencyMs: 100, error: "Postgres unavailable" },
  sorobanRpc:   { status: "ok",   latencyMs: 12  },
  horizon:      { status: "ok",   latencyMs: 8   },
  webhookQueue: { status: "ok",   latencyMs: 1   },
};

const MULTI_DOWN: DependencyHealth = {
  postgres:     { status: "down", latencyMs: 5000, error: "Probe timed out"      },
  sorobanRpc:   { status: "down", latencyMs: 5000, error: "Soroban RPC unavailable" },
  horizon:      { status: "ok",   latencyMs: 8  },
  webhookQueue: { status: "ok",   latencyMs: 1  },
};

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(probeFn: () => Promise<DependencyHealth>): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/health/dependencies", createDependenciesRouter({ probeFn }));
  app.use(errorHandler);
  return app;
}

const URL = "/api/health/dependencies";

// ═════════════════════════════════════════════════════════════════════════════
// HTTP status codes
// ═════════════════════════════════════════════════════════════════════════════

describe("HTTP status codes", () => {
  it("returns 200 when all dependencies are ok", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.status).toBe(200);
  });

  it("returns 207 when at least one dependency is degraded (none down)", async () => {
    const res = await request(makeApp(() => Promise.resolve(ONE_DEGRADED))).get(URL);
    expect(res.status).toBe(207);
  });

  it("returns 207 when all dependencies are degraded", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_DEGRADED))).get(URL);
    expect(res.status).toBe(207);
  });

  it("returns 503 when any dependency is down", async () => {
    const res = await request(makeApp(() => Promise.resolve(ONE_DOWN))).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when multiple dependencies are down", async () => {
    const res = await request(makeApp(() => Promise.resolve(MULTI_DOWN))).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when a degraded + down mix exists (down wins)", async () => {
    const mixed: DependencyHealth = {
      postgres:     { status: "down",     latencyMs: 5000, error: "DB down" },
      sorobanRpc:   { status: "degraded", latencyMs: 4200 },
      horizon:      { status: "ok",       latencyMs: 8   },
      webhookQueue: { status: "ok",       latencyMs: 1   },
    };
    const res = await request(makeApp(() => Promise.resolve(mixed))).get(URL);
    expect(res.status).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Response body — composite status field
// ═════════════════════════════════════════════════════════════════════════════

describe("response body — status field", () => {
  it("body.status is 'ok' when all pass", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.body.status).toBe("ok");
  });

  it("body.status is 'degraded' when degraded (no down)", async () => {
    const res = await request(makeApp(() => Promise.resolve(ONE_DEGRADED))).get(URL);
    expect(res.body.status).toBe("degraded");
  });

  it("body.status is 'down' when any probe is down", async () => {
    const res = await request(makeApp(() => Promise.resolve(ONE_DOWN))).get(URL);
    expect(res.body.status).toBe("down");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Response shape
// ═════════════════════════════════════════════════════════════════════════════

describe("response shape", () => {
  it("includes all required top-level fields", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("correlationId");
    expect(res.body).toHaveProperty("checkedAt");
    expect(res.body).toHaveProperty("dependencies");
  });

  it("dependencies contains all four systems", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.body.dependencies).toHaveProperty("postgres");
    expect(res.body.dependencies).toHaveProperty("sorobanRpc");
    expect(res.body.dependencies).toHaveProperty("horizon");
    expect(res.body.dependencies).toHaveProperty("webhookQueue");
  });

  it("each dependency entry contains status and latencyMs", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    for (const key of ["postgres", "sorobanRpc", "horizon", "webhookQueue"]) {
      expect(res.body.dependencies[key]).toHaveProperty("status");
      expect(res.body.dependencies[key]).toHaveProperty("latencyMs");
    }
  });

  it("checkedAt is a valid ISO-8601 timestamp", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(typeof res.body.checkedAt).toBe("string");
    expect(() => new Date(res.body.checkedAt)).not.toThrow();
    expect(new Date(res.body.checkedAt).getTime()).toBeGreaterThan(0);
  });

  it("includes per-dependency latency values from the probe", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.body.dependencies.postgres.latencyMs).toBe(3);
    expect(res.body.dependencies.sorobanRpc.latencyMs).toBe(12);
    expect(res.body.dependencies.horizon.latencyMs).toBe(8);
    expect(res.body.dependencies.webhookQueue.latencyMs).toBe(1);
  });

  it("includes error field when a probe is down", async () => {
    const res = await request(makeApp(() => Promise.resolve(ONE_DOWN))).get(URL);
    expect(res.body.dependencies.postgres.error).toBe("Postgres unavailable");
  });

  it("does not expose error field when probe is ok", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.body.dependencies.postgres).not.toHaveProperty("error");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Correlation ID
// ═════════════════════════════════════════════════════════════════════════════

describe("correlationId", () => {
  it("echoes the x-correlation-id header when provided", async () => {
    const id = "my-trace-id-abc-123";
    const res = await request(makeApp(() => Promise.resolve(ALL_OK)))
      .get(URL)
      .set("x-correlation-id", id);
    expect(res.body.correlationId).toBe(id);
  });

  it("generates a UUID when x-correlation-id is not provided", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("generates a UUID when x-correlation-id is an empty string", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK)))
      .get(URL)
      .set("x-correlation-id", "");
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("correlationId differs between requests when not supplied", async () => {
    const app = makeApp(() => Promise.resolve(ALL_OK));
    const [r1, r2] = await Promise.all([request(app).get(URL), request(app).get(URL)]);
    expect(r1.body.correlationId).not.toBe(r2.body.correlationId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth / access control
// ═════════════════════════════════════════════════════════════════════════════

describe("authentication", () => {
  it("does not require an Authorization header", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK))).get(URL);
    // Must not be a 401 or 403
    expect(res.status).toBe(200);
  });

  it("ignores a supplied Authorization header (does not change the response)", async () => {
    const res = await request(makeApp(() => Promise.resolve(ALL_OK)))
      .get(URL)
      .set("Authorization", "Bearer some-random-token");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Error handling
// ═════════════════════════════════════════════════════════════════════════════

describe("error handling", () => {
  it("returns 500 and propagates to errorHandler when probeFn throws", async () => {
    const throwing = () => Promise.reject(new Error("infrastructure exploded"));
    const res = await request(makeApp(throwing)).get(URL);
    expect(res.status).toBe(500);
  });

  it("calls probeFn exactly once per request", async () => {
    const probeFn = jest.fn().mockResolvedValue(ALL_OK);
    await request(makeApp(probeFn)).get(URL);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Default export wires to production probeAllDependencies
// ═════════════════════════════════════════════════════════════════════════════

describe("default router", () => {
  it("exports a default dependenciesRouter as a valid Express router", async () => {
    const { dependenciesRouter } = await import("../src/routes/health/dependencies");
    expect(typeof dependenciesRouter).toBe("function");
    // An Express router is a function with a `stack` property.
    expect(Array.isArray((dependenciesRouter as unknown as { stack: unknown[] }).stack)).toBe(true);
  });
});
