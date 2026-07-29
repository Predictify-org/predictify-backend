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

import { BackupVerificationWorker } from "../src/workers/backupVerificationWorker";
import { Worker } from "bullmq";

describe("BackupVerificationWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workerCallback = null;
  });

  it("can start and stop the worker", async () => {
    const mockVerifier = { run: jest.fn().mockResolvedValue({ success: true, runId: "123" }) };
    const factory = () => mockVerifier as any;
    const worker = new BackupVerificationWorker(factory, 2);

    worker.start();
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(Worker).toHaveBeenCalledWith(
      "backup-verification",
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );

    await worker.stop();
    const workerInstance = (Worker as unknown as jest.Mock).mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });

  it("processes the job successfully when verification succeeds", async () => {
    const mockVerifier = { run: jest.fn().mockResolvedValue({ success: true, runId: "123" }) };
    const factory = () => mockVerifier as any;
    const worker = new BackupVerificationWorker(factory, 1);
    worker.start();

    expect(workerCallback).toBeDefined();
    const result = await workerCallback({ id: "job-1" });
    expect(mockVerifier.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, runId: "123" });
  });

  it("throws error when verification fails", async () => {
    const mockVerifier = { run: jest.fn().mockResolvedValue({ success: false, error: "smoke test failed", runId: "124" }) };
    const factory = () => mockVerifier as any;
    const worker = new BackupVerificationWorker(factory, 1);
    worker.start();

    expect(workerCallback).toBeDefined();
    await expect(workerCallback({ id: "job-2" })).rejects.toThrow("smoke test failed");
  });
});
