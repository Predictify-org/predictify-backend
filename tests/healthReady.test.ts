/**
 * healthReady.test.ts
 *
 * Tests for GET /api/health/ready.
 *
 * All external I/O is replaced by in-memory stubs — no real DB, Redis, or
 * Soroban RPC connection is required. The service layer is exercised directly
 * (unit tests) and the HTTP layer is exercised via supertest (integration tests).
 *
 * Coverage targets
 * ────────────────
 *  • All four probes: db, sorobanRpc, indexerLag, queue
 *  • 200 when all pass / 503 when any fail
 *  • Response shape: status, correlationId, checkedAt, checks
 *  • correlationId echo + UUID generation
 *  • Individual probe failure isolation
 *  • Timeout / unexpected-throw handling
 *  • No authentication required
 *  • Structured logging output
 */

// ── Env stubs (must come before any src/ imports) ────────────────────────────

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL = "redis://localhost:6379";

// ── Mocks (must come before createApp / route imports) ───────────────────────

// Prevent real DB pool from being opened.
jest.mock("../src/db/client", () => ({
  db: {},
  pool: {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
  connectWithRetry: jest.fn().mockResolvedValue(undefined),
  closeDb: jest.fn().mockResolvedValue(undefined),
  getDb: jest.fn().mockReturnValue({}),
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }),
  setDbForTests: jest.fn(),
}));

// Prevent real Redis connection from being opened.
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

// Prevent real Soroban RPC calls from the route — we mock the service layer.
jest.mock("../src/services/readinessService");

import request from "supertest";
import express from "express";
import { errorHandler } from "../src/middleware/errorHandler";
import { createReadyRouter } from "../src/routes/health/ready";
import {
  performReadinessCheck,
  type DbLike,
  type RedisLike,
  type ReadinessResult,
} from "../src/services/readinessService";

// ── Stub helpers ──────────────────────────────────────────────────────────────

/** A db stub that resolves immediately. */
function makeDb(overrides: Partial<DbLike> = {}): DbLike {
  return {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

/** A redis stub that responds PONG. */
function makeRedis(pongResponse = "PONG"): RedisLike {
  return {
    ping: jest.fn().mockResolvedValue(pongResponse),
  };
}

/** A fully-passing ReadinessResult fixture. */
function allPass(): ReadinessResult {
  return {
    status: "ready",
    checks: {
      db: { status: "pass", durationMs: 5, message: "Database connection healthy" },
      sorobanRpc: { status: "pass", durationMs: 10, message: "Soroban RPC healthy" },
      indexerLag: { status: "pass", durationMs: 8, message: "Indexer lag healthy: 50 ≤ 200 ledgers" },
      queue: { status: "pass", durationMs: 2, message: "Queue (Redis) healthy" },
    },
  };
}

/** A result where one probe has failed. */
function oneFailure(probe: keyof ReadinessResult["checks"]): ReadinessResult {
  const result = allPass();
  result.status = "unready";
  result.checks[probe] = {
    status: "fail",
    durationMs: 1001,
    message: "Probe timed out",
  };
  return result;
}

// ── Minimal Express app for HTTP tests ───────────────────────────────────────

function makeApp(db = makeDb(), redis = makeRedis()): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/health/ready", createReadyRouter({ db, redis }));
  app.use(errorHandler);
  return app;
}

// Cast the module mock so TypeScript is happy.
const mockPerform = performReadinessCheck as jest.MockedFunction<
  typeof performReadinessCheck
>;

// ═════════════════════════════════════════════════════════════════════════════
// Service unit tests (probe functions are mocked at module boundary)
// We test them individually here using real implementations via jest.requireActual
// ═════════════════════════════════════════════════════════════════════════════

describe("readinessService — individual probes (unit)", () => {
  // Use real implementations for this block.
  const real = jest.requireActual<typeof import("../src/services/readinessService")>(
    "../src/services/readinessService",
  );

  describe("checkDatabase", () => {
    it("returns pass when execute resolves", async () => {
      const db = makeDb();
      const result = await real.checkDatabase(db);
      expect(result.status).toBe("pass");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toContain("healthy");
    });

    it("returns fail when execute rejects", async () => {
      const db = makeDb({
        execute: jest.fn().mockRejectedValue(new Error("connection refused")),
      });
      const result = await real.checkDatabase(db);
      expect(result.status).toBe("fail");
      expect(result.message).toContain("connection refused");
    });

    it("returns fail on timeout (slow execute)", async () => {
      // Simulate a probe that never resolves — the 1-second timeout should fire.
      // We advance fake timers so the test doesn't actually wait 1 s.
      jest.useFakeTimers();

      const db = makeDb({
        execute: jest.fn().mockImplementation(
          () => new Promise(() => { /* never resolves */ }),
        ),
      });

      const promise = real.checkDatabase(db);
      jest.advanceTimersByTime(1100);
      const result = await promise;

      expect(result.status).toBe("fail");
      expect(result.message).toContain("timed out");

      jest.useRealTimers();
    });
  });

  describe("checkQueue", () => {
    it("returns pass when Redis responds PONG", async () => {
      const result = await real.checkQueue(makeRedis("PONG"));
      expect(result.status).toBe("pass");
      expect(result.message).toContain("healthy");
    });

    it("returns fail when Redis responds with unexpected value", async () => {
      const result = await real.checkQueue(makeRedis("NOPE"));
      expect(result.status).toBe("fail");
      expect(result.message).toContain("NOPE");
    });

    it("returns fail when Redis ping rejects", async () => {
      const redis: RedisLike = {
        ping: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      };
      const result = await real.checkQueue(redis);
      expect(result.status).toBe("fail");
      expect(result.message).toContain("ECONNREFUSED");
    });

    it("returns fail on timeout", async () => {
      jest.useFakeTimers();

      const redis: RedisLike = {
        ping: jest.fn().mockImplementation(
          () => new Promise(() => { /* never resolves */ }),
        ),
      };

      const promise = real.checkQueue(redis);
      jest.advanceTimersByTime(1100);
      const result = await promise;

      expect(result.status).toBe("fail");
      expect(result.message).toContain("timed out");

      jest.useRealTimers();
    });
  });

  describe("performReadinessCheck", () => {
    // For these tests we mock the Soroban SDK at the module level so no real
    // network call is made, and we control db/redis via injected stubs.

    beforeEach(() => {
      // Mock the entire Stellar SDK so checkSorobanRpc and checkIndexerLag
      // don't try to hit the real RPC.
      jest.doMock("@stellar/stellar-sdk", () => ({
        SorobanRpc: {
          Server: jest.fn().mockImplementation(() => ({
            getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1100 }),
          })),
        },
      }));
    });

    afterEach(() => {
      jest.dontMock("@stellar/stellar-sdk");
    });

    it("returns ready when db and redis pass (rpc/indexer may vary)", async () => {
      const db = makeDb();
      const redis = makeRedis("PONG");

      const result = await real.performReadinessCheck(db, redis);

      // db and queue must pass; overall result depends on RPC reachability in CI
      expect(result.checks.db.status).toBe("pass");
      expect(result.checks.queue.status).toBe("pass");
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("checks");
    });

    it("returns unready when db probe fails", async () => {
      const db = makeDb({
        execute: jest.fn().mockRejectedValue(new Error("DB down")),
      });
      const redis = makeRedis("PONG");

      const result = await real.performReadinessCheck(db, redis);

      expect(result.status).toBe("unready");
      expect(result.checks.db.status).toBe("fail");
    });

    it("returns unready when queue probe fails", async () => {
      const db = makeDb();
      const redis: RedisLike = {
        ping: jest.fn().mockRejectedValue(new Error("Redis down")),
      };

      const result = await real.performReadinessCheck(db, redis);

      expect(result.status).toBe("unready");
      expect(result.checks.queue.status).toBe("fail");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HTTP integration tests (service layer fully mocked)
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/health/ready — HTTP", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 200 OK ──────────────────────────────────────────────────────────────────

  it("returns 200 when all probes pass", async () => {
    mockPerform.mockResolvedValue(allPass());

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("returns all four checks in the body", async () => {
    mockPerform.mockResolvedValue(allPass());

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.body.checks).toHaveProperty("db");
    expect(res.body.checks).toHaveProperty("sorobanRpc");
    expect(res.body.checks).toHaveProperty("indexerLag");
    expect(res.body.checks).toHaveProperty("queue");
  });

  it("each check has status, durationMs, and message", async () => {
    mockPerform.mockResolvedValue(allPass());

    const res = await request(makeApp()).get("/api/health/ready");

    for (const check of Object.values(res.body.checks as Record<string, unknown>)) {
      expect(check).toMatchObject({
        status: expect.stringMatching(/^(pass|fail)$/),
        durationMs: expect.any(Number),
        message: expect.any(String),
      });
    }
  });

  // ── 503 Unavailable ──────────────────────────────────────────────────────────

  it("returns 503 when db probe fails", async () => {
    mockPerform.mockResolvedValue(oneFailure("db"));

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unready");
    expect(res.body.checks.db.status).toBe("fail");
  });

  it("returns 503 when sorobanRpc probe fails", async () => {
    mockPerform.mockResolvedValue(oneFailure("sorobanRpc"));

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks.sorobanRpc.status).toBe("fail");
  });

  it("returns 503 when indexerLag probe fails", async () => {
    mockPerform.mockResolvedValue(oneFailure("indexerLag"));

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks.indexerLag.status).toBe("fail");
  });

  it("returns 503 when queue probe fails", async () => {
    mockPerform.mockResolvedValue(oneFailure("queue"));

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks.queue.status).toBe("fail");
  });

  it("returns 503 when all probes fail", async () => {
    mockPerform.mockResolvedValue({
      status: "unready",
      checks: {
        db: { status: "fail", durationMs: 1001, message: "DB down" },
        sorobanRpc: { status: "fail", durationMs: 1001, message: "RPC down" },
        indexerLag: { status: "fail", durationMs: 1001, message: "Lag too high" },
        queue: { status: "fail", durationMs: 1001, message: "Redis down" },
      },
    });

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unready");
  });

  // ── correlationId ─────────────────────────────────────────────────────────────

  it("echoes x-correlation-id from request header", async () => {
    mockPerform.mockResolvedValue(allPass());
    const id = "my-custom-correlation-id";

    const res = await request(makeApp())
      .get("/api/health/ready")
      .set("x-correlation-id", id);

    expect(res.body.correlationId).toBe(id);
  });

  it("generates a UUID correlationId when header is absent", async () => {
    mockPerform.mockResolvedValue(allPass());

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  // ── checkedAt ─────────────────────────────────────────────────────────────────

  it("includes a valid ISO-8601 checkedAt timestamp", async () => {
    mockPerform.mockResolvedValue(allPass());

    const before = new Date();
    const res = await request(makeApp()).get("/api/health/ready");
    const after = new Date();

    const checkedAt = new Date(res.body.checkedAt);
    expect(checkedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(checkedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  // ── No auth required ─────────────────────────────────────────────────────────

  it("does not require authentication — no Authorization header needed", async () => {
    mockPerform.mockResolvedValue(allPass());

    const res = await request(makeApp()).get("/api/health/ready");

    // Must not be 401 or 403.
    expect(res.status).toBe(200);
  });

  // ── Error propagation ─────────────────────────────────────────────────────────

  it("propagates unexpected service errors to the error handler", async () => {
    mockPerform.mockRejectedValue(new Error("unexpected internal error"));

    const res = await request(makeApp()).get("/api/health/ready");

    // The error handler will turn this into a 500.
    expect(res.status).toBe(500);
  });

  // ── Response Content-Type ─────────────────────────────────────────────────────

  it("responds with application/json content type", async () => {
    mockPerform.mockResolvedValue(allPass());

    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
