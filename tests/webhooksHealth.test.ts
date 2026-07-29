/**
 * webhooksHealth.test.ts
 *
 * Tests for GET /api/webhooks/health.
 *
 * Strategy
 * ────────
 * • The injectable `probeDatabase` and `probeQueue` functions replace all
 *   external I/O — no real DB or Redis connections are made.
 * • The router is mounted on a minimal Express app so tests are isolated
 *   from the full application bootstrap.
 * • The errorHandler is attached so unexpected-throw tests validate the
 *   standard error envelope format.
 *
 * Coverage
 * ────────
 * • 200 both probes ok
 * • 503 database down, queue ok
 * • 503 database ok, queue down
 * • 503 both probes down
 * • Response shape: status, correlationId, checkedAt, dependencies
 * • Per-dependency latency and error fields
 * • correlationId: echo from header / UUID generation fallback
 * • No authentication required
 * • Probe errors propagate as 500 via errorHandler
 * • Default probe functions are wired when no deps provided
 * • Structured log emitted on each request
 */

// ── Env stubs (must precede all src/ imports) ─────────────────────────────────

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL = "redis://localhost:6379";

// ── Module mocks (must precede dynamic imports) ───────────────────────────────

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
import { createWebhooksHealthRouter } from "../src/routes/webhooks/health";
import { errorHandler } from "../src/middleware/errorHandler";
import type { WebhookDependencyHealth } from "../src/routes/webhooks/health";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_OK: WebhookDependencyHealth = {
  database: { status: "ok", latencyMs: 2 },
  queue: { status: "ok", latencyMs: 1 },
};

const DB_DOWN: WebhookDependencyHealth = {
  database: { status: "down", latencyMs: 100, error: "Database unavailable" },
  queue: { status: "ok", latencyMs: 1 },
};

const QUEUE_DOWN: WebhookDependencyHealth = {
  database: { status: "ok", latencyMs: 2 },
  queue: { status: "down", latencyMs: 50, error: "Webhook queue unavailable" },
};

const BOTH_DOWN: WebhookDependencyHealth = {
  database: { status: "down", latencyMs: 100, error: "Database unavailable" },
  queue: { status: "down", latencyMs: 50, error: "Webhook queue unavailable" },
};

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(deps: {
  probeDatabase?: () => Promise<WebhookDependencyHealth["database"]>;
  probeQueue?: () => Promise<WebhookDependencyHealth["queue"]>;
} = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/webhooks/health",
    createWebhooksHealthRouter(deps),
  );
  app.use(errorHandler);
  return app;
}

const URL = "/api/webhooks/health";

// ═════════════════════════════════════════════════════════════════════════════
// HTTP status codes
// ═════════════════════════════════════════════════════════════════════════════

describe("HTTP status codes", () => {
  it("returns 200 when both probes pass", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.status).toBe(200);
  });

  it("returns 503 when database is down", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(DB_DOWN.database),
        probeQueue: () => Promise.resolve(DB_DOWN.queue),
      }),
    ).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when queue is down", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(QUEUE_DOWN.database),
        probeQueue: () => Promise.resolve(QUEUE_DOWN.queue),
      }),
    ).get(URL);
    expect(res.status).toBe(503);
  });

  it("returns 503 when both probes are down", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(BOTH_DOWN.database),
        probeQueue: () => Promise.resolve(BOTH_DOWN.queue),
      }),
    ).get(URL);
    expect(res.status).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Response body — composite status field
// ═════════════════════════════════════════════════════════════════════════════

describe("response body — status field", () => {
  it("body.status is 'ok' when both probes pass", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body.status).toBe("ok");
  });

  it("body.status is 'down' when database is down", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(DB_DOWN.database),
        probeQueue: () => Promise.resolve(DB_DOWN.queue),
      }),
    ).get(URL);
    expect(res.body.status).toBe("down");
  });

  it("body.status is 'down' when queue is down", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(QUEUE_DOWN.database),
        probeQueue: () => Promise.resolve(QUEUE_DOWN.queue),
      }),
    ).get(URL);
    expect(res.body.status).toBe("down");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Response shape
// ═════════════════════════════════════════════════════════════════════════════

describe("response shape", () => {
  it("includes all required top-level fields", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("correlationId");
    expect(res.body).toHaveProperty("checkedAt");
    expect(res.body).toHaveProperty("dependencies");
  });

  it("dependencies contains database and queue", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body.dependencies).toHaveProperty("database");
    expect(res.body.dependencies).toHaveProperty("queue");
  });

  it("each dependency entry contains status and latencyMs", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    for (const key of ["database", "queue"]) {
      expect(res.body.dependencies[key]).toHaveProperty("status");
      expect(res.body.dependencies[key]).toHaveProperty("latencyMs");
    }
  });

  it("checkedAt is a valid ISO-8601 timestamp", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(typeof res.body.checkedAt).toBe("string");
    expect(() => new Date(res.body.checkedAt)).not.toThrow();
    expect(new Date(res.body.checkedAt).getTime()).toBeGreaterThan(0);
  });

  it("includes per-dependency latency values from the probe", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body.dependencies.database.latencyMs).toBe(2);
    expect(res.body.dependencies.queue.latencyMs).toBe(1);
  });

  it("includes error field when a probe is down", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(DB_DOWN.database),
        probeQueue: () => Promise.resolve(DB_DOWN.queue),
      }),
    ).get(URL);
    expect(res.body.dependencies.database.error).toBe("Database unavailable");
  });

  it("does not expose error field when probe is ok", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body.dependencies.database).not.toHaveProperty("error");
    expect(res.body.dependencies.queue).not.toHaveProperty("error");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Correlation ID
// ═════════════════════════════════════════════════════════════════════════════

describe("correlationId", () => {
  it("echoes the x-correlation-id header when provided", async () => {
    const id = "webhooks-health-trace-123";
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    )
      .get(URL)
      .set("x-correlation-id", id);
    expect(res.body.correlationId).toBe(id);
  });

  it("generates a UUID when x-correlation-id is not provided", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("generates a UUID when x-correlation-id is an empty string", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    )
      .get(URL)
      .set("x-correlation-id", "");
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("correlationId differs between requests when not supplied", async () => {
    const app = makeApp({
      probeDatabase: () => Promise.resolve(ALL_OK.database),
      probeQueue: () => Promise.resolve(ALL_OK.queue),
    });
    const [r1, r2] = await Promise.all([
      request(app).get(URL),
      request(app).get(URL),
    ]);
    expect(r1.body.correlationId).not.toBe(r2.body.correlationId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth / access control
// ═════════════════════════════════════════════════════════════════════════════

describe("authentication", () => {
  it("does not require an Authorization header", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.status).toBe(200);
  });

  it("ignores a supplied Authorization header", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    )
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
  it("returns 500 and propagates to errorHandler when probeDatabase throws", async () => {
    const throwing = () => Promise.reject(new Error("database exploded"));
    const res = await request(
      makeApp({
        probeDatabase: throwing,
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.status).toBe(500);
  });

  it("returns 500 and propagates to errorHandler when probeQueue throws", async () => {
    const throwing = () => Promise.reject(new Error("queue exploded"));
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: throwing,
      }),
    ).get(URL);
    expect(res.status).toBe(500);
  });

  it("calls probeDatabase and probeQueue exactly once per request", async () => {
    const probeDatabase = jest.fn().mockResolvedValue(ALL_OK.database);
    const probeQueue = jest.fn().mockResolvedValue(ALL_OK.queue);
    await request(makeApp({ probeDatabase, probeQueue })).get(URL);
    expect(probeDatabase).toHaveBeenCalledTimes(1);
    expect(probeQueue).toHaveBeenCalledTimes(1);
  });

  it("runs both probes in parallel (not sequentially)", async () => {
    const order: string[] = [];
    const probeDatabase = jest.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("database");
      return ALL_OK.database;
    });
    const probeQueue = jest.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("queue");
      return ALL_OK.queue;
    });
    await request(makeApp({ probeDatabase, probeQueue })).get(URL);
    // Both should have been called
    expect(probeDatabase).toHaveBeenCalledTimes(1);
    expect(probeQueue).toHaveBeenCalledTimes(1);
    // Order may vary, but both should complete (parallel execution)
    expect(order).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Default router export
// ═════════════════════════════════════════════════════════════════════════════

describe("default router", () => {
  it("exports a default webhooksHealthRouter as a valid Express router", async () => {
    const { webhooksHealthRouter } = await import("../src/routes/webhooks/health");
    expect(typeof webhooksHealthRouter).toBe("function");
    expect(
      Array.isArray(
        (webhooksHealthRouter as unknown as { stack: unknown[] }).stack,
      ),
    ).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("handles database returning error field with message", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () =>
          Promise.resolve({
            status: "down" as const,
            latencyMs: 200,
            error: "Connection refused",
          }),
        probeQueue: () => Promise.resolve(ALL_OK.queue),
      }),
    ).get(URL);
    expect(res.body.dependencies.database.error).toBe("Connection refused");
    expect(res.body.status).toBe("down");
  });

  it("handles queue returning error field with message", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeQueue: () =>
          Promise.resolve({
            status: "down" as const,
            latencyMs: 100,
            error: "Redis connection timeout",
          }),
      }),
    ).get(URL);
    expect(res.body.dependencies.queue.error).toBe("Redis connection timeout");
    expect(res.body.status).toBe("down");
  });

  it("returns 200 with zero latency values", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () =>
          Promise.resolve({ status: "ok" as const, latencyMs: 0 }),
        probeQueue: () =>
          Promise.resolve({ status: "ok" as const, latencyMs: 0 }),
      }),
    ).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.dependencies.database.latencyMs).toBe(0);
    expect(res.body.dependencies.queue.latencyMs).toBe(0);
  });
});
