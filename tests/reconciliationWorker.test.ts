/* eslint-disable @typescript-eslint/no-explicit-any */
let workerCallback: any = null;

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }));
});
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
jest.mock("../src/services/reconciliationService", () => ({
  performReconciliation: jest.fn(),
  reconcileMarket: jest.fn(),
}));
jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: "audit-1" }),
}));
jest.mock("../src/metrics/registry", () => ({
  reconciliationDiscrepanciesTotal: {
    inc: jest.fn(),
  },
}));

import { ReconciliationWorker, ReconciliationJobPayload } from "../src/workers/reconciliationWorker";
import { performReconciliation, reconcileMarket } from "../src/services/reconciliationService";
import { createAuditLog } from "../src/services/auditService";
import { reconciliationDiscrepanciesTotal } from "../src/metrics/registry";
import { Worker } from "bullmq";

describe("ReconciliationWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workerCallback = null;
  });

  it("can start and stop the worker", async () => {
    const worker = new ReconciliationWorker(3);
    worker.start();
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(Worker).toHaveBeenCalledWith(
      "reconciliation",
      expect.any(Function),
      expect.objectContaining({ concurrency: 3 }),
    );

    await worker.stop();
    const workerInstance = (Worker as unknown as jest.Mock).mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });

  it("runs global reconciliation when job type is global", async () => {
    const worker = new ReconciliationWorker(1);
    worker.start();

    (performReconciliation as jest.Mock).mockResolvedValue({ skipped: true });

    expect(workerCallback).toBeDefined();
    const result = await workerCallback({ id: "job-global", data: { type: "global" } });
    expect(performReconciliation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ skipped: true });
  });

  it("completes global job with status discrepancies_found, increments metrics and creates audit row", async () => {
    const worker = new ReconciliationWorker(1);
    worker.start();

    const mockReport = {
      reportId: "rep-1",
      fingerprint: "fp-1",
      status: "discrepancies_found",
      totalKeys: 2,
      matchedKeys: 1,
      unmatchedKeys: 1,
      discrepancyCount: 1,
      summary: { claimed_on_chain_missing_in_db: 1 },
      discrepancies: [
        {
          kind: "claimed_on_chain_missing_in_db",
          marketId: "market-1",
          stellarAddress: "user-1",
        },
      ],
    };
    (performReconciliation as jest.Mock).mockResolvedValue(mockReport);

    expect(workerCallback).toBeDefined();
    const result = await workerCallback({ id: "job-global-disc", data: { type: "global" } });
    expect(performReconciliation).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("discrepancies_found");
    expect(reconciliationDiscrepanciesTotal.inc).toHaveBeenCalledWith({
      kind: "claimed_on_chain_missing_in_db",
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reconciliation.discrepancies_found",
        metadata: expect.objectContaining({
          reportId: "rep-1",
          fingerprint: "fp-1",
          discrepancyCount: 1,
        }),
      }),
    );
  });

  it("runs market reconciliation when job type is market", async () => {
    const worker = new ReconciliationWorker(1);
    worker.start();

    const mockResult = { marketId: "market-1", status: "ok" };
    (reconcileMarket as jest.Mock).mockResolvedValue(mockResult);

    const payload: ReconciliationJobPayload = {
      type: "market",
      marketId: "market-1",
      adminAddress: "address-1",
      ip: "127.0.0.1",
      correlationId: "id-1",
    };

    expect(workerCallback).toBeDefined();
    const result = await workerCallback({ id: "job-market", data: payload });
    expect(reconcileMarket).toHaveBeenCalledTimes(1);
    expect(reconcileMarket).toHaveBeenCalledWith({
      marketId: "market-1",
      adminAddress: "address-1",
      ip: "127.0.0.1",
      correlationId: "id-1",
    });
    expect(result).toEqual(mockResult);
  });

  it("throws error when market reconciliation parameters are missing", async () => {
    const worker = new ReconciliationWorker(1);
    worker.start();

    expect(workerCallback).toBeDefined();
    await expect(
      workerCallback({ id: "job-market-fail", data: { type: "market", marketId: "market-1" } })
    ).rejects.toThrow("Missing required parameters for market reconciliation");
  });

  it("throws error for unknown job types", async () => {
    const worker = new ReconciliationWorker(1);
    worker.start();

    expect(workerCallback).toBeDefined();
    await expect(
      workerCallback({ id: "job-unknown", data: { type: "unknown" } })
    ).rejects.toThrow("Unknown reconciliation job type: unknown");
  });
});
