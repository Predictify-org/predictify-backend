// Set up environment variables before importing anything that parses them
process.env.JWT_SECRET = "super-secret-key-that-is-at-least-32-bytes-long";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";
process.env.ADMIN_ALLOWLIST = "G-ADMIN-ADDRESS-1,G-ADMIN-ADDRESS-2";
process.env.INDEXER_HEALTH_MAX_LAG = "50";

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("../src/services/indexerService", () => ({
  indexerService: {
    getCursor: jest.fn(),
    getChainTip: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import { createIndexerHealthRouter } from "../src/routes/indexer/health";
import { indexerService } from "../src/services/indexerService";
import { errorHandler } from "../src/middleware/errorHandler";
import { API_SECURITY_HEADERS } from "../src/middleware/securityHeaders";

// ── Types ────────────────────────────────────────────────────────────────────

import type {
  ProbeResult,
  IndexerDependencyHealth,
} from "../src/routes/indexer/health";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_OK: IndexerDependencyHealth = {
  database: { status: "ok", latencyMs: 2 },
  sorobanRpc: { status: "ok", latencyMs: 5 },
};

const DB_DOWN: IndexerDependencyHealth = {
  database: { status: "down", latencyMs: 100, error: "Database unavailable" },
  sorobanRpc: { status: "ok", latencyMs: 5 },
};

const RPC_DOWN: IndexerDependencyHealth = {
  database: { status: "ok", latencyMs: 2 },
  sorobanRpc: { status: "down", latencyMs: 200, error: "Soroban RPC unavailable" },
};

const BOTH_DOWN: IndexerDependencyHealth = {
  database: { status: "down", latencyMs: 100, error: "Database unavailable" },
  sorobanRpc: { status: "down", latencyMs: 200, error: "Soroban RPC unavailable" },
};

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(deps: {
  probeDatabase?: () => Promise<ProbeResult>;
  probeSorobanRpc?: () => Promise<ProbeResult>;
} = {}): express.Express {
  const app = express();
  app.use("/api/indexer", createIndexerHealthRouter(deps));
  app.use(errorHandler);
  return app;
}

const URL = "/api/indexer/health";

// ═════════════════════════════════════════════════════════════════════════════
// Lag-based status tests
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/indexer/health — lag-based status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports ok when cursor lag is within the threshold", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "ok",
      cursor: 1000,
      chainTip: 1010,
      lag: 10,
    });
  });

  it("reports degraded when cursor lag exceeds the threshold", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(2000);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("degraded");
    expect(res.body.data.lag).toBe(1000);
  });

  it("reports down when the chain tip is unreachable", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockRejectedValue(new Error("rpc unavailable"));

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("down");
    expect(res.body.data.chainTip).toBeNull();
    expect(res.body.data.lag).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Dependency probe tests
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/indexer/health — dependency probes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);
  });

  it("returns dependencies object with database and sorobanRpc", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.dependencies).toBeDefined();
    expect(res.body.dependencies.database).toBeDefined();
    expect(res.body.dependencies.sorobanRpc).toBeDefined();
  });

  it("reports database as ok when probe succeeds", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.dependencies.database.status).toBe("ok");
    expect(res.body.dependencies.database.latencyMs).toBe(2);
  });

  it("reports database as down when probe fails", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(DB_DOWN.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.dependencies.database.status).toBe("down");
    expect(res.body.dependencies.database.error).toBe("Database unavailable");
  });

  it("reports sorobanRpc as ok when probe succeeds", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.dependencies.sorobanRpc.status).toBe("ok");
    expect(res.body.dependencies.sorobanRpc.latencyMs).toBe(5);
  });

  it("reports sorobanRpc as down when probe fails", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(RPC_DOWN.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.dependencies.sorobanRpc.status).toBe("down");
    expect(res.body.dependencies.sorobanRpc.error).toBe("Soroban RPC unavailable");
  });

  it("includes top-level status, correlationId, and checkedAt fields", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBeDefined();
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.body.checkedAt).toBeDefined();
    expect(() => new Date(res.body.checkedAt)).not.toThrow();
  });

  it("each dependency entry contains status and latencyMs", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    for (const key of ["database", "sorobanRpc"]) {
      expect(res.body.dependencies[key]).toHaveProperty("status");
      expect(res.body.dependencies[key]).toHaveProperty("latencyMs");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Overall status computation
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/indexer/health — overall status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is 'ok' when deps are healthy and lag is within threshold", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBe("ok");
  });

  it("is 'degraded' when lag exceeds threshold but deps are ok", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(2000);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.database.status).toBe("ok");
    expect(res.body.dependencies.sorobanRpc.status).toBe("ok");
  });

  it("is 'down' when database is down", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(DB_DOWN.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBe("down");
  });

  it("is 'down' when sorobanRpc is down", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(RPC_DOWN.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBe("down");
  });

  it("is 'down' when both deps are down", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(BOTH_DOWN.database),
        probeSorobanRpc: () => Promise.resolve(BOTH_DOWN.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBe("down");
  });

  it("is 'down' when chain tip is unreachable even if deps are ok", async () => {
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockRejectedValue(new Error("rpc unavailable"));

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.status).toBe("down");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Other behaviours
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/indexer/health — other behaviours", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (indexerService.getCursor as jest.Mock).mockResolvedValue(1000);
    (indexerService.getChainTip as jest.Mock).mockResolvedValue(1010);
  });

  it("does not require authentication", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(200);
  });

  it("sets CSP, X-Content-Type-Options, and Referrer-Policy response headers on /api/indexer responses", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(
      API_SECURITY_HEADERS["Content-Security-Policy"],
    );
    expect(res.headers["x-content-type-options"]).toBe(
      API_SECURITY_HEADERS["X-Content-Type-Options"],
    );
    expect(res.headers["referrer-policy"]).toBe(
      API_SECURITY_HEADERS["Referrer-Policy"],
    );
  });

  it("echoes x-correlation-id header when provided", async () => {
    const id = "indexer-health-trace-123";
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    )
      .get(URL)
      .set("x-correlation-id", id);

    expect(res.body.correlationId).toBe(id);
  });

  it("runs probes and indexer service in parallel", async () => {
    const order: string[] = [];
    const probeDatabase = jest.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("database");
      return ALL_OK.database;
    });
    const probeSorobanRpc = jest.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("sorobanRpc");
      return ALL_OK.sorobanRpc;
    });
    (indexerService.getCursor as jest.Mock).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("cursor");
      return 1000;
    });

    await request(makeApp({ probeDatabase, probeSorobanRpc })).get(URL);

    expect(probeDatabase).toHaveBeenCalledTimes(1);
    expect(probeSorobanRpc).toHaveBeenCalledTimes(1);
    expect(indexerService.getCursor).toHaveBeenCalledTimes(1);
    expect(order).toHaveLength(3);
  });

  it("returns 500 and propagates to errorHandler when getCursor throws", async () => {
    (indexerService.getCursor as jest.Mock).mockRejectedValue(new Error("DB exploded"));

    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(500);
  });

  it("returns 500 when probeDatabase throws", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.reject(new Error("database exploded")),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.status).toBe(500);
  });

  it("does not leak error field when probe is ok", async () => {
    const res = await request(
      makeApp({
        probeDatabase: () => Promise.resolve(ALL_OK.database),
        probeSorobanRpc: () => Promise.resolve(ALL_OK.sorobanRpc),
      }),
    ).get(URL);

    expect(res.body.dependencies.database).not.toHaveProperty("error");
    expect(res.body.dependencies.sorobanRpc).not.toHaveProperty("error");
  });
});
