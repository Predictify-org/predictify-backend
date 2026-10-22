/* eslint-disable @typescript-eslint/no-explicit-any */
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
  performReconciliation,
  ClaimEventSource,
  ClaimEvent,
  PredictionRecord,
  ClaimRecord,
} from "../src/services/reconciliationService";
import { createAdminReconciliationRouter } from "../src/routes/admin/reconciliation";
import { errorHandler } from "../src/middleware/errorHandler";
import { ReconciliationWorker } from "../src/workers/reconciliationWorker";
import { reconciliationDiscrepanciesTotal } from "../src/metrics/registry";
import { createAuditLog } from "../src/services/auditService";

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }));
});

let workerCallback: any = null;
jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation((name) => ({ name })),
    Worker: jest.fn().mockImplementation((_name, cb) => {
      workerCallback = cb;
      return {
        on: jest.fn(),
        close: jest.fn(),
      };
    }),
    QueueEvents: jest.fn(),
  };
});

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: "audit-1" }),
}));

jest.mock("../src/metrics/registry", () => ({
  reconciliationDiscrepanciesTotal: {
    inc: jest.fn(),
  },
}));

const SECRET = process.env.JWT_SECRET || "predictify-test-jwt-secret-key-32-chars-long";
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "test-request-id";
    next();
  });
  app.use("/api/admin/recon", createAdminReconciliationRouter());
  app.use(errorHandler);
  return app;
}

class FakeClaimEventSource implements ClaimEventSource {
  constructor(private readonly events: ClaimEvent[]) {}

  async getClaimEvents(): Promise<ClaimEvent[]> {
    return this.events;
  }
}

describe("Payout Reconciliation Comprehensive Test Suite (Issue #980 Test Plan)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Scenario 1: Every source agrees ───────────────────────────────────────
  it("Scenario 1: Every source agrees -> zero discrepancies; report status ok", async () => {
    const user = "GUSER1111111111111111111111111111111111111111111111111111";
    const market = "market-1";
    const amount = "10.0000000";

    const predictionsFixture: PredictionRecord[] = [
      {
        id: "pred-1",
        userId: "user-1",
        stellarAddress: user,
        marketId: market,
        amount,
        status: "confirmed",
        result: "won",
        claimTxHash: "tx-clm-1",
        createdAt: new Date(),
      },
    ];

    const claimsFixture: ClaimRecord[] = [
      {
        id: "clm-1",
        userId: "user-1",
        stellarAddress: user,
        marketId: market,
        amount,
        status: "paid",
        settlementTx: "tx-clm-1",
        settledAt: new Date(),
        createdAt: new Date(),
      },
    ];

    const eventsFixture: ClaimEvent[] = [
      {
        eventId: "evt-1",
        ledger: 100,
        txHash: "tx-clm-1",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount,
        timestamp: new Date(),
      },
    ];

    const result = await performReconciliation({
      predictionsFixture,
      claimsFixture,
      eventsFixture,
    });

    expect(result.status).toBe("ok");
    expect(result.discrepancyCount).toBe(0);
    expect(result.discrepancies).toEqual([]);
    expect(result.fingerprint).toBeDefined();
    expect(typeof result.fingerprint).toBe("string");
  });

  // ── Scenario 2: win_clm event exists with no claims row ───────────────────
  it("Scenario 2: A win_clm event exists with no claims row -> claimed_on_chain_missing_in_db", async () => {
    const user = "GUSER2222222222222222222222222222222222222222222222222222";
    const market = "market-2";

    const fakeSource = new FakeClaimEventSource([
      {
        eventId: "evt-2",
        ledger: 102,
        txHash: "tx-evt-2",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount: "5.0000000",
        timestamp: new Date(),
      },
    ]);

    const result = await performReconciliation({
      predictionsFixture: [],
      claimsFixture: [],
      claimEventSource: fakeSource,
    });

    expect(result.status).toBe("discrepancies_found");
    expect(result.discrepancyCount).toBe(1);
    expect(result.discrepancies[0].kind).toBe("claimed_on_chain_missing_in_db");
    expect(result.discrepancies[0].marketId).toBe(market);
    expect(result.discrepancies[0].stellarAddress).toBe(user);
    expect(result.discrepancies[0].onChainAmount).toBe("5.0000000");
  });

  // ── Scenario 3: claims row is paid with no matching event ─────────────────
  it("Scenario 3: A claims row is paid with no matching event -> db_paid_missing_on_chain", async () => {
    const user = "GUSER3333333333333333333333333333333333333333333333333333";
    const market = "market-3";

    const claimsFixture: ClaimRecord[] = [
      {
        id: "clm-3",
        userId: "user-3",
        stellarAddress: user,
        marketId: market,
        amount: "15.0000000",
        status: "paid",
        settlementTx: "tx-clm-3",
        settledAt: new Date(),
        createdAt: new Date(),
      },
    ];

    const result = await performReconciliation({
      predictionsFixture: [],
      claimsFixture,
      eventsFixture: [],
    });

    expect(result.status).toBe("discrepancies_found");
    expect(result.discrepancyCount).toBe(1);
    expect(result.discrepancies[0].kind).toBe("db_paid_missing_on_chain");
    expect(result.discrepancies[0].marketId).toBe(market);
    expect(result.discrepancies[0].stellarAddress).toBe(user);
    expect(result.discrepancies[0].dbAmount).toBe("15.0000000");
  });

  // ── Scenario 4: Event amount differs by 1 stroop ───────────────────────────
  it("Scenario 4: Event amount differs from claim amount by 1 stroop -> amount_mismatch with exact values", async () => {
    const user = "GUSER4444444444444444444444444444444444444444444444444444";
    const market = "market-4";

    const claimsFixture: ClaimRecord[] = [
      {
        id: "clm-4",
        userId: "user-4",
        stellarAddress: user,
        marketId: market,
        amount: "10.0000000",
        status: "paid",
        settlementTx: "tx-clm-4",
        settledAt: new Date(),
        createdAt: new Date(),
      },
    ];

    const eventsFixture: ClaimEvent[] = [
      {
        eventId: "evt-4",
        ledger: 104,
        txHash: "tx-evt-4",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount: "10.0000001", // 1 stroop higher
        timestamp: new Date(),
      },
    ];

    const result = await performReconciliation({
      predictionsFixture: [],
      claimsFixture,
      eventsFixture,
    });

    expect(result.status).toBe("discrepancies_found");
    const d = result.discrepancies.find((x) => x.kind === "amount_mismatch");
    expect(d).toBeDefined();
    expect(d?.dbAmount).toBe("10.0000000");
    expect(d?.onChainAmount).toBe("10.0000001");
    expect(d?.difference).toBe("-0.0000001");
  });

  // ── Scenario 5: Claim event for prediction with result = 'lost' ───────────
  it("Scenario 5: A claim event for a prediction with result = 'lost' -> claim_for_losing_prediction", async () => {
    const user = "GUSER5555555555555555555555555555555555555555555555555555";
    const market = "market-5";

    const predictionsFixture: PredictionRecord[] = [
      {
        id: "pred-5",
        userId: "user-5",
        stellarAddress: user,
        marketId: market,
        amount: "25.0000000",
        status: "confirmed",
        result: "lost",
        claimTxHash: null,
        createdAt: new Date(),
      },
    ];

    const eventsFixture: ClaimEvent[] = [
      {
        eventId: "evt-5",
        ledger: 105,
        txHash: "tx-evt-5",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount: "25.0000000",
        timestamp: new Date(),
      },
    ];

    const result = await performReconciliation({
      predictionsFixture,
      claimsFixture: [],
      eventsFixture,
    });

    expect(result.status).toBe("discrepancies_found");
    const d = result.discrepancies.find((x) => x.kind === "claim_for_losing_prediction");
    expect(d).toBeDefined();
    expect(d?.marketId).toBe(market);
    expect(d?.stellarAddress).toBe(user);
    expect(d?.predictionId).toBe("pred-5");
  });

  // ── Scenario 6: Two win_clm events for the same (user, market) ───────────
  it("Scenario 6: Two win_clm events for the same (user, market) -> duplicate_on_chain_claim", async () => {
    const user = "GUSER6666666666666666666666666666666666666666666666666666";
    const market = "market-6";

    const eventsFixture: ClaimEvent[] = [
      {
        eventId: "evt-6a",
        ledger: 106,
        txHash: "tx-6a",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount: "10.0000000",
        timestamp: new Date(),
      },
      {
        eventId: "evt-6b",
        ledger: 107,
        txHash: "tx-6b",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount: "10.0000000",
        timestamp: new Date(),
      },
    ];

    const result = await performReconciliation({
      predictionsFixture: [],
      claimsFixture: [],
      eventsFixture,
    });

    expect(result.status).toBe("discrepancies_found");
    const d = result.discrepancies.find((x) => x.kind === "duplicate_on_chain_claim");
    expect(d).toBeDefined();
    expect(d?.marketId).toBe(market);
    expect(d?.stellarAddress).toBe(user);
  });

  // ── Scenario 7: Won and unclaimed longer than threshold ───────────────────
  it("Scenario 7: Won and unclaimed longer than threshold -> stale_unclaimed", async () => {
    const user = "GUSER7777777777777777777777777777777777777777777777777777";
    const market = "market-7";
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago

    const predictionsFixture: PredictionRecord[] = [
      {
        id: "pred-7",
        userId: "user-7",
        stellarAddress: user,
        marketId: market,
        amount: "50.0000000",
        status: "confirmed",
        result: "won",
        claimTxHash: null,
        createdAt: oldDate,
      },
    ];

    const result = await performReconciliation({
      predictionsFixture,
      claimsFixture: [],
      eventsFixture: [],
      staleThresholdDays: 30,
    });

    expect(result.status).toBe("discrepancies_found");
    const d = result.discrepancies.find((x) => x.kind === "stale_unclaimed");
    expect(d).toBeDefined();
    expect(d?.marketId).toBe(market);
    expect(d?.stellarAddress).toBe(user);
    expect(d?.predictionId).toBe("pred-7");
    expect(d?.dbAmount).toBe("50.0000000");
  });

  // ── Scenario 8: Idempotent runs and deterministic fingerprints ────────────
  it("Scenario 8: Same run twice produces identical fingerprint and no duplicate discrepancies", async () => {
    const user = "GUSER8888888888888888888888888888888888888888888888888888";
    const market = "market-8";

    const eventsFixture: ClaimEvent[] = [
      {
        eventId: "evt-8",
        ledger: 108,
        txHash: "tx-evt-8",
        eventType: "win_clm",
        marketId: market,
        userAddress: user,
        amount: "8.0000000",
        timestamp: new Date("2026-06-01T00:00:00.000Z"),
      },
    ];

    const run1 = await performReconciliation({
      predictionsFixture: [],
      claimsFixture: [],
      eventsFixture,
    });

    const run2 = await performReconciliation({
      predictionsFixture: [],
      claimsFixture: [],
      eventsFixture,
    });

    expect(run1.fingerprint).toBe(run2.fingerprint);
    expect(run1.discrepancyCount).toBe(run2.discrepancyCount);
    expect(run1.discrepancies).toEqual(run2.discrepancies);
  });

  // ── Scenario 9: Admin endpoints without admin token -> 401/403 ────────────
  it("Scenario 9: Admin endpoints without admin token return 401/403", async () => {
    const app = makeApp();

    const noAuthReports = await request(app).get("/api/admin/recon/reports");
    expect([401, 403]).toContain(noAuthReports.status);

    const userAuthReports = await request(app)
      .get("/api/admin/recon/reports")
      .set("Authorization", `Bearer ${signJwt({ sub: USER_ADDRESS, role: "user" })}`);
    expect(userAuthReports.status).toBe(403);

    const noAuthSingle = await request(app).get("/api/admin/recon/reports/rep-123");
    expect([401, 403]).toContain(noAuthSingle.status);

    const userAuthSingle = await request(app)
      .get("/api/admin/recon/reports/rep-123")
      .set("Authorization", `Bearer ${signJwt({ sub: USER_ADDRESS, role: "user" })}`);
    expect(userAuthSingle.status).toBe(403);
  });

  // ── Scenario 10: 50,000 keys test completes within memory bounds (< 100 MB)
  it("Scenario 10: 50,000 keys benchmark completes with heap growth < 100 MB", async () => {
    const count = 50_000;
    const predictionsFixture: PredictionRecord[] = [];
    const claimsFixture: ClaimRecord[] = [];
    const eventsFixture: ClaimEvent[] = [];

    for (let i = 0; i < count; i++) {
      const addr = `GUSER${i.toString().padStart(50, "0")}`;
      const mkt = `market-${i % 500}`;
      const amt = "10.0000000";

      predictionsFixture.push({
        id: `p-${i}`,
        userId: `u-${i}`,
        stellarAddress: addr,
        marketId: mkt,
        amount: amt,
        status: "confirmed",
        result: "won",
        claimTxHash: `tx-${i}`,
        createdAt: new Date(),
      });

      claimsFixture.push({
        id: `c-${i}`,
        userId: `u-${i}`,
        stellarAddress: addr,
        marketId: mkt,
        amount: amt,
        status: "paid",
        settlementTx: `tx-${i}`,
        settledAt: new Date(),
        createdAt: new Date(),
      });

      eventsFixture.push({
        eventId: `e-${i}`,
        ledger: 1000 + i,
        txHash: `tx-${i}`,
        eventType: "win_clm",
        marketId: mkt,
        userAddress: addr,
        amount: amt,
        timestamp: new Date(),
      });
    }

    if (global.gc) {
      global.gc();
    }
    const initialHeap = process.memoryUsage().heapUsed;

    const result = await performReconciliation({
      predictionsFixture,
      claimsFixture,
      eventsFixture,
    });

    expect(result.status).toBe("ok");
    expect(result.totalKeys).toBe(count);
    expect(result.discrepancyCount).toBe(0);

    const finalHeap = process.memoryUsage().heapUsed;
    const heapGrowthBytes = finalHeap - initialHeap;
    const maxAllowedBytes = 100 * 1024 * 1024; // 100 MB

    expect(heapGrowthBytes).toBeLessThan(maxAllowedBytes);
  }, 30000);

  // ── Scenario 11: Worker job with discrepancies ────────────────────────────
  it("Scenario 11: Worker job with discrepancies -> status discrepancies_found, metric incremented, audit row written", async () => {
    const worker = new ReconciliationWorker(1);
    worker.start();

    expect(workerCallback).toBeDefined();

    const mockReport = {
      reportId: "rep-disc-11",
      fingerprint: "fp-disc-11",
      status: "discrepancies_found" as const,
      totalKeys: 5,
      matchedKeys: 4,
      unmatchedKeys: 1,
      discrepancyCount: 1,
      summary: { claimed_on_chain_missing_in_db: 1 },
      discrepancies: [
        {
          kind: "claimed_on_chain_missing_in_db" as const,
          marketId: "market-11",
          stellarAddress: "GUSER11",
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const spy = jest
      .spyOn(require("../src/services/reconciliationService"), "performReconciliation")
      .mockResolvedValueOnce(mockReport as any);

    // Simulate worker execution with the callback
    const result = await workerCallback({
      id: "job-11",
      data: { type: "global" },
    });

    expect(result.status).toBe("discrepancies_found");
    expect(reconciliationDiscrepanciesTotal.inc).toHaveBeenCalledWith({
      kind: "claimed_on_chain_missing_in_db",
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reconciliation.discrepancies_found",
        metadata: expect.objectContaining({
          reportId: "rep-disc-11",
          discrepancyCount: 1,
        }),
      }),
    );

    spy.mockRestore();
    await worker.stop();
  });

  // ── Database persistence and retrieval methods ────────────────────────────
  describe("Database persistence, DefaultDbClaimEventSource and report retrieval", () => {
    it("DefaultDbClaimEventSource queries indexerEvents correctly", async () => {
      const mockRows = [
        {
          id: "evt-db-1",
          txHash: "tx-db-1",
          ledger: 101,
          marketId: "mkt-1",
          eventType: "win_clm",
          canonical: true,
          data: {
            userAddress: "GUSERDB1",
            amount: "10.0000000",
          },
          createdAt: new Date(),
        },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(mockRows),
          }),
        }),
      };

      const source = new (require("../src/services/reconciliationService").DefaultDbClaimEventSource)(mockDb);
      const events = await source.getClaimEvents({
        since: new Date(Date.now() - 3600000),
        until: new Date(),
      });

      expect(events).toHaveLength(1);
      expect(events[0].txHash).toBe("tx-db-1");
      expect(events[0].userAddress).toBe("GUSERDB1");
      expect(events[0].amount).toBe("10.0000000");
    });

    it("DefaultDbClaimEventSource handles errors gracefully", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.reject(new Error("db failure")),
          }),
        }),
      };

      const source = new (require("../src/services/reconciliationService").DefaultDbClaimEventSource)(mockDb);
      const events = await source.getClaimEvents();
      expect(events).toEqual([]);
    });

    it("persists reconciliation report and discrepancies when dbClient is provided", async () => {
      let insertedReport: any = null;
      let insertedDiscrepancies: any = null;

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]), // no existing
            }),
          }),
        }),
        insert: (table: any) => ({
          values: (vals: any) => ({
            onConflictDoNothing: () => ({
              returning: () => {
                insertedReport = vals;
                return Promise.resolve([vals]);
              },
            }),
            then: (resolve: any) => {
              insertedDiscrepancies = vals;
              return Promise.resolve(vals).then(resolve);
            },
          }),
        }),
      };

      const result = await performReconciliation({
        predictionsFixture: [],
        claimsFixture: [],
        eventsFixture: [
          {
            eventId: "e-persist-1",
            ledger: 200,
            txHash: "tx-persist-1",
            eventType: "win_clm",
            marketId: "mkt-p",
            userAddress: "GUSER_P",
            amount: "5.0000000",
            timestamp: new Date(),
          },
        ],
        persist: true,
        dbClient: mockDb,
      });

      expect(result.status).toBe("discrepancies_found");
      expect(insertedReport).toBeDefined();
      expect(insertedReport.id).toBe(result.reportId);
      expect(insertedDiscrepancies).toBeDefined();
      expect(insertedDiscrepancies).toHaveLength(1);
    });

    it("getReconciliationReport retrieves report and discrepancies from dbClient", async () => {
      const { getReconciliationReport } = require("../src/services/reconciliationService");

      const mockReportRow = {
        id: "rep-get-1",
        fingerprint: "fp-get-1",
        status: "ok",
        since: new Date("2026-06-01T00:00:00.000Z"),
        until: new Date("2026-06-02T00:00:00.000Z"),
        totalKeys: 5,
        matchedKeys: 5,
        unmatchedKeys: 0,
        discrepancyCount: 0,
        summary: {},
        createdAt: new Date("2026-06-02T01:00:00.000Z"),
      };

      const mockDb = {
        select: () => ({
          from: (table: any) => ({
            where: () => {
              const p: any = Promise.resolve([]);
              p.limit = () => Promise.resolve([mockReportRow]);
              return p;
            },
          }),
        }),
      };

      const report = await getReconciliationReport("rep-get-1", mockDb);
      expect(report).toBeDefined();
      expect(report?.reportId).toBe("rep-get-1");
      expect(report?.status).toBe("ok");
    });

    it("getReconciliationReport returns null when report not found", async () => {
      const { getReconciliationReport } = require("../src/services/reconciliationService");
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      };

      const report = await getReconciliationReport("non-existent", mockDb);
      expect(report).toBeNull();
    });

    it("listReconciliationReports retrieves paginated reports with keyset cursor", async () => {
      const { listReconciliationReports } = require("../src/services/reconciliationService");

      const mockRows = [
        {
          id: "rep-list-1",
          fingerprint: "fp-list-1",
          status: "ok",
          since: null,
          until: null,
          totalKeys: 1,
          matchedKeys: 1,
          unmatchedKeys: 0,
          discrepancyCount: 0,
          summary: {},
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(mockRows),
              }),
            }),
            orderBy: () => ({
              limit: () => Promise.resolve(mockRows),
            }),
          }),
        }),
      };

      const res = await listReconciliationReports({
        limit: 10,
        cursor: Buffer.from("2026-06-01T00:00:00.000Z::rep-0").toString("base64"),
        dbClient: mockDb,
      });

      expect(res.reports).toHaveLength(1);
      expect(res.reports[0].reportId).toBe("rep-list-1");
    });

    it("listReconciliationReports handles hasMore and array responses", async () => {
      const { listReconciliationReports } = require("../src/services/reconciliationService");

      const mockTwoRows = [
        { id: "r1", createdAt: new Date() },
        { id: "r2", createdAt: new Date() },
      ];
      const mockDbTwo = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(mockTwoRows),
              }),
            }),
            orderBy: () => ({
              limit: () => Promise.resolve(mockTwoRows),
            }),
          }),
        }),
      };

      const listHasMore = await listReconciliationReports({ limit: 1, dbClient: mockDbTwo });
      expect(listHasMore.nextCursor).toBeDefined();

      const listNum = await listReconciliationReports(1, 0, mockDbTwo);
      expect(Array.isArray(listNum)).toBe(true);

      const listFail = await listReconciliationReports({
        dbClient: {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () => Promise.reject(new Error("fail")),
                }),
              }),
            }),
          }),
        },
      });
      expect(listFail.reports).toEqual([]);
    });

    it("getReconciliationReport maps discrepancies rows correctly", async () => {
      const { getReconciliationReport } = require("../src/services/reconciliationService");

      const mockReportWithDisc = {
        id: "rep-disc-get",
        fingerprint: "fp-disc-get",
        status: "discrepancies_found",
        since: new Date(),
        until: new Date(),
        totalKeys: 1,
        matchedKeys: 0,
        unmatchedKeys: 1,
        discrepancyCount: 1,
        summary: { claimed_on_chain_missing_in_db: 1 },
        createdAt: new Date(),
      };
      const mockDiscRow = {
        reportId: "rep-disc-get",
        kind: "claimed_on_chain_missing_in_db",
        userId: "u-1",
        stellarAddress: "GUSER1",
        marketId: "m-1",
        predictionId: "p-1",
        claimId: "c-1",
        txHash: "tx-1",
        dbAmount: "10.0000000",
        onChainAmount: "10.0000000",
        difference: "0.0000000",
        details: { foo: "bar" },
      };
      const mockDbDisc = {
        select: () => ({
          from: () => ({
            where: () => {
              const p: any = Promise.resolve([mockDiscRow]);
              p.limit = () => Promise.resolve([mockReportWithDisc]);
              return p;
            },
          }),
        }),
      };
      const repWithDisc = await getReconciliationReport("rep-disc-get", mockDbDisc);
      expect(repWithDisc?.discrepancies).toHaveLength(1);
      expect(repWithDisc?.discrepancies[0].kind).toBe("claimed_on_chain_missing_in_db");
    });

    it("performReconciliation queries dbClient when fixtures are omitted and handles existing report", async () => {
      const mockDbAll = {
        select: (fields?: any) => ({
          from: (table: any) => ({
            innerJoin: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: "p-1",
                    userId: "u-1",
                    stellarAddress: "GUSER1",
                    marketId: "m-1",
                    amount: "10.0000000",
                    status: "confirmed",
                    result: "won",
                    claimTxHash: "tx-1",
                    createdAt: new Date(),
                  },
                ]),
            }),
            where: () => ({
              limit: () =>
                Promise.resolve([
                  { id: "existing-report-id" }, // existing report
                ]),
            }),
          }),
        }),
      };

      const resDb = await performReconciliation({
        since: new Date(Date.now() - 3600000),
        until: new Date(),
        persist: true,
        dbClient: mockDbAll,
      });

      expect(resDb.reportId).toBe("existing-report-id");
    });

    it("handles persistence errors, get errors, and null dbClient gracefully", async () => {
      const {
        getReconciliationReport,
        listReconciliationReports,
      } = require("../src/services/reconciliationService");

      // getReconciliationReport when db throws
      const failDb = {
        select: () => ({
          from: () => ({
            where: () => {
              throw new Error("unexpected error");
            },
          }),
        }),
      };
      const nullReport = await getReconciliationReport("rep-err", failDb);
      expect(nullReport).toBeNull();

      // getReconciliationReport with null
      const nullClientReport = await getReconciliationReport("rep-err", null);
      expect(nullClientReport).toBeNull();

      // listReconciliationReports with null
      const nullList = await listReconciliationReports({ dbClient: null });
      expect(nullList).toEqual({ reports: [], nextCursor: null });

      const nullListNum = await listReconciliationReports(10, 0, null);
      expect(nullListNum).toEqual([]);

      // performReconciliation when db query throws
      const errDb = {
        select: () => {
          throw new Error("db fail");
        },
      };
      const resErr = await performReconciliation({ dbClient: errDb });
      expect(resErr.status).toBe("ok");

      // performReconciliation when persist throws
      const persistFailDb = {
        select: () => ({
          from: () => ({
            where: () => {
              throw new Error("persist fail");
            },
          }),
        }),
      };
      const repFail = await performReconciliation({
        predictionsFixture: [],
        claimsFixture: [],
        eventsFixture: [],
        persist: true,
        dbClient: persistFailDb,
      });
      expect(repFail.status).toBe("ok");
    });
  });

  // ── Exact arithmetic & market reconciliation edge tests ───────────────────
  describe("Exact arithmetic & helper coverage", () => {
    it("tests parseExactStroops and formatExactStroops edge cases", () => {
      const {
        parseExactStroops,
        formatExactStroops,
      } = require("../src/services/reconciliationService");

      expect(() => parseExactStroops("invalid")).toThrow();
      expect(parseExactStroops("10.5")).toBe(105000000n);
      expect(parseExactStroops("-5.0")).toBe(-50000000n);
      expect(parseExactStroops("")).toBe(0n);
      expect(parseExactStroops(null)).toBe(0n);
      expect(formatExactStroops(0n)).toBe("0");
      expect(formatExactStroops(-10000000n)).toBe("-1");
      expect(formatExactStroops(-1n)).toBe("-0.0000001");
      expect(formatExactStroops(15000000n)).toBe("1.5");
    });

    it("tests DefaultOnChainMarketStateProvider and createReconciliationService", async () => {
      const {
        DefaultOnChainMarketStateProvider,
        createReconciliationService,
      } = require("../src/services/reconciliationService");

      const provider = new DefaultOnChainMarketStateProvider();
      const pos = await provider.getMarketPositions("market-test");
      expect(pos.available).toBe(false);

      const service = createReconciliationService({
        marketExists: jest.fn().mockResolvedValue(true),
        getDbPositions: jest.fn().mockResolvedValue([]),
        getOnChainPositions: jest.fn().mockResolvedValue({
          positions: [],
          source: "soroban-rpc",
          available: false,
          unavailableReason: null,
        }),
        writeAudit: jest.fn().mockResolvedValue("corr-exp"),
      });

      const res = await service.reconcileMarket({
        marketId: "market-1",
        adminAddress: ADMIN_ADDRESS,
        ip: "127.0.0.1",
        correlationId: "corr-exp",
      });
      expect(res.status).toBe("partial");
    });
  });
});
