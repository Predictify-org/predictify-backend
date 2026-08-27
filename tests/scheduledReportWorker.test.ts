jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: unknown) => ({
    processor,
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/queue", () => ({
  redisConnection: {},
  scheduledReportQueueName: "scheduled-report-runs",
}));

import { Worker } from "bullmq";
import { ScheduledReportWorker } from "../src/workers/scheduledReportWorker";
import { ReportRunRepository } from "../src/services/scheduledReportJobService";

describe("ScheduledReportWorker", () => {
  it("starts one BullMQ worker and is idempotent", () => {
    const worker = new ScheduledReportWorker({} as ReportRunRepository);
    worker.start();
    worker.start();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  it("closes the worker during stop and tolerates repeated stop", async () => {
    const worker = new ScheduledReportWorker({} as ReportRunRepository);
    worker.start();
    await worker.stop();
    await worker.stop();
    const instance = (Worker as unknown as jest.Mock).mock.results.at(-1)?.value;
    expect(instance.close).toHaveBeenCalledTimes(1);
  });
});
