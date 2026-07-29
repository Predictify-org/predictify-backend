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

import { ReconciliationWorker, ReconciliationJobPayload } from "../src/workers/reconciliationWorker";
import { performReconciliation, reconcileMarket } from "../src/services/reconciliationService";
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
