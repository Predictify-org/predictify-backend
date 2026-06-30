/**
 * Unit tests for seedService.
 *
 * Strategy:
 *  - Mock db/client so importing the service never opens a Pool.
 *  - Mock auditService + logging/events so the service's only real moving part
 *    is the (injected) repository.
 *  - Exercise the Drizzle repository against a hand-rolled fake query builder.
 */

jest.mock("../src/db/client", () => ({ db: {} }));
jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("corr-id"),
}));
jest.mock("../src/logging/events", () => ({
  emitMarketEvent: jest.fn(),
  LogEvent: { MARKET_CREATED: "market.created" },
}));

import {
  seedSampleMarkets,
  SAMPLE_MARKETS,
  SEED_BATCH_VERSION,
  SeedNotAllowedError,
  DrizzleSeedRepository,
  type SeedRepository,
  type SeededMarketSummary,
} from "../src/services/seedService";
import { env } from "../src/config/env";
import { createAuditLog } from "../src/services/auditService";
import { emitMarketEvent } from "../src/logging/events";

const mockAudit = createAuditLog as jest.MockedFunction<typeof createAuditLog>;
const mockEmit = emitMarketEvent as jest.MockedFunction<typeof emitMarketEvent>;

const CTX = { adminAddress: "GADMIN", ip: "1.2.3.4", correlationId: "req-1" };

/** In-memory fake repo that mimics ON CONFLICT DO NOTHING semantics. */
function makeRepo(existingIds: string[] = []): SeedRepository & {
  store: Set<string>;
  insertSampleMarkets: jest.Mock;
  listSeededMarkets: jest.Mock;
} {
  const store = new Set(existingIds);
  return {
    store,
    insertSampleMarkets: jest.fn(async (rows: { id: string }[]) => {
      const inserted: string[] = [];
      for (const r of rows) {
        if (!store.has(r.id)) {
          store.add(r.id);
          inserted.push(r.id);
        }
      }
      return inserted;
    }),
    listSeededMarkets: jest.fn(async (): Promise<SeededMarketSummary[]> =>
      [...store].sort().map((id) => ({
        id,
        question: "q",
        status: "open",
        resolutionTime: "2026-01-01T00:00:00.000Z",
      })),
    ),
  };
}

beforeEach(() => jest.clearAllMocks());

describe("seedSampleMarkets", () => {
  it("inserts the whole batch on a fresh database", async () => {
    const repo = makeRepo();
    const result = await seedSampleMarkets(CTX, repo);

    expect(result.requested).toBe(SAMPLE_MARKETS.length);
    expect(result.inserted).toBe(SAMPLE_MARKETS.length);
    expect(result.skipped).toBe(0);
    expect(result.batchVersion).toBe(SEED_BATCH_VERSION);
    expect(result.insertedIds).toHaveLength(SAMPLE_MARKETS.length);
    expect(result.markets).toHaveLength(SAMPLE_MARKETS.length);

    // One created-event per inserted row + one audit entry.
    expect(mockEmit).toHaveBeenCalledTimes(SAMPLE_MARKETS.length);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.seed_markets",
        walletAddress: "GADMIN",
        ip: "1.2.3.4",
        correlationId: "req-1",
      }),
    );
  });

  it("is idempotent — a repeat run inserts nothing and emits no events", async () => {
    const repo = makeRepo(SAMPLE_MARKETS.map((m) => m.id));
    const result = await seedSampleMarkets(CTX, repo);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(SAMPLE_MARKETS.length);
    expect(result.insertedIds).toEqual([]);
    expect(result.markets).toHaveLength(SAMPLE_MARKETS.length);
    expect(mockEmit).not.toHaveBeenCalled();
    // Audit is still written so the (no-op) admin action is traceable.
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  it("propagates the admin address as the created-event actor", async () => {
    const repo = makeRepo();
    await seedSampleMarkets(CTX, repo);
    expect(mockEmit).toHaveBeenCalledWith(
      "market.created",
      expect.objectContaining({ actor: "GADMIN", seeded: true, correlationId: "req-1" }),
    );
  });

  it("refuses to seed in production", async () => {
    const repo = makeRepo();
    const original = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    try {
      await expect(seedSampleMarkets(CTX, repo)).rejects.toBeInstanceOf(
        SeedNotAllowedError,
      );
      expect(repo.insertSampleMarkets).not.toHaveBeenCalled();
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = original;
    }
  });
});

describe("SeedNotAllowedError", () => {
  it("carries a 403 status and stable code", () => {
    const err = new SeedNotAllowedError();
    expect(err.status).toBe(403);
    expect(err.code).toBe("seed_not_allowed");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("DrizzleSeedRepository", () => {
  it("insertSampleMarkets short-circuits on empty input", async () => {
    const repo = new DrizzleSeedRepository({} as never);
    expect(await repo.insertSampleMarkets([])).toEqual([]);
  });

  it("insertSampleMarkets maps the ids Postgres returns", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    const repo = new DrizzleSeedRepository({ insert } as never);

    const ids = await repo.insertSampleMarkets([{ id: "a" } as never]);

    expect(ids).toEqual(["a", "b"]);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: expect.anything() });
  });

  it("listSeededMarkets serializes Date resolutionTime to ISO", async () => {
    const rows = [
      {
        id: "seed-market-001",
        question: "q",
        status: "open",
        resolutionTime: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const orderBy = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const repo = new DrizzleSeedRepository({ select } as never);

    const out = await repo.listSeededMarkets();
    expect(out).toEqual([
      {
        id: "seed-market-001",
        question: "q",
        status: "open",
        resolutionTime: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("listSeededMarkets stringifies a non-Date resolutionTime", async () => {
    const rows = [
      { id: "x", question: "q", status: "open", resolutionTime: "2026-01-01" },
    ];
    const orderBy = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const repo = new DrizzleSeedRepository({ select } as never);

    const out = await repo.listSeededMarkets();
    expect(out[0]!.resolutionTime).toBe("2026-01-01");
  });
});
