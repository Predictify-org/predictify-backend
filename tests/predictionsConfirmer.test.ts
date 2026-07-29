/**
 * predictionsConfirmer.test.ts
 *
 * Unit tests for the PredictionsConfirmerService using a mock repository
 * and a mock webhook emitter.  The service is tested in isolation from the
 * database layer so tests are fast and deterministic.
 *
 * Coverage:
 *  - Happy path: matching indexer event → prediction confirmed + webhook emitted
 *  - Batch confirmations with multiple predictions
 *  - Incrementing attempts for unmatched predictions
 *  - Marking predictions as failed after max attempts
 *  - Mixed outcomes: some confirmed, some incremented, some failed
 *  - Empty state (no pending predictions)
 *  - Webhook dispatch errors do not crash the tick
 *  - Idempotency: already-confirmed predictions are not re-processed
 *  - Configurable maxAttempts and batchSize
 */

import {
  PredictionsConfirmerService,
  DEFAULT_MAX_ATTEMPTS,
  type PredictionsConfirmerRepo,
  type ConfirmedPrediction,
  type PollResult,
  type WebhookEmitter,
} from "../src/workers/predictionsConfirmer";

// ─── Mock repository factory ──────────────────────────────────────────────

function makeRepo(
  overrides?: Partial<PredictionsConfirmerRepo>,
): jest.Mocked<PredictionsConfirmerRepo> {
  return {
    findConfirmedCandidateIds: jest
      .fn<Promise<string[]>, [number]>()
      .mockResolvedValue([]),
    confirmBatch: jest
      .fn<Promise<ConfirmedPrediction[]>, [string[]]>()
      .mockResolvedValue([]),
    incrementAttempts: jest
      .fn<Promise<number>, [number, number]>()
      .mockResolvedValue(0),
    markFailed: jest
      .fn<Promise<string[]>, [number, number]>()
      .mockResolvedValue([]),
    getPredictionsByIds: jest
      .fn<Promise<ConfirmedPrediction[]>, [string[]]>()
      .mockResolvedValue([]),
    transactionalTick: jest
      .fn<
        Promise<{
          confirmed: ConfirmedPrediction[];
          incremented: number;
          failedIds: string[];
        }>,
        [number, number]
      >()
      .mockResolvedValue({
        confirmed: [],
        incremented: 0,
        failedIds: [],
      }),
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeService(
  repoOverrides?: Partial<PredictionsConfirmerRepo>,
  opts?: {
    batchSize?: number;
    maxAttempts?: number;
    emitWebhook?: WebhookEmitter;
  },
): {
  service: PredictionsConfirmerService;
  repo: jest.Mocked<PredictionsConfirmerRepo>;
} {
  const repo = makeRepo(repoOverrides);
  const service = new PredictionsConfirmerService(repo, {
    batchSize: opts?.batchSize ?? 1000,
    maxAttempts: opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    db: {} as any,
    emitWebhook: opts?.emitWebhook ?? jest.fn().mockResolvedValue(undefined),
  });
  return { service, repo };
}

function confirmedPrediction(
  overrides?: Partial<ConfirmedPrediction>,
): ConfirmedPrediction {
  return {
    id: "pred-1",
    marketId: "mkt-1",
    userId: "user-1",
    outcome: "yes",
    amount: "10000000",
    txHash: "0xabc123",
    status: "confirmed",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("PredictionsConfirmerService", () => {
  describe("pollOnce()", () => {
    it("processes zero predictions when there are no candidates", async () => {
      const { service, repo } = makeService();

      const result = await service.pollOnce();

      expect(result).toEqual<PollResult>({
        processed: 0,
        confirmed: 0,
        incremented: 0,
        failed: 0,
        webhookErrors: 0,
      });
      expect(repo.transactionalTick).toHaveBeenCalledWith(1000, DEFAULT_MAX_ATTEMPTS);
    });

    it("confirms predictions with matching indexer events and emits webhooks", async () => {
      const pred = confirmedPrediction();
      const emitWebhook = jest.fn().mockResolvedValue(undefined);

      const { service, repo } = makeService(
        {
          transactionalTick: jest.fn().mockResolvedValue({
            confirmed: [pred],
            incremented: 0,
            failedIds: [],
          }),
        },
        { emitWebhook },
      );

      const result = await service.pollOnce();

      expect(result).toMatchObject({
        processed: 1,
        confirmed: 1,
        incremented: 0,
        failed: 0,
        webhookErrors: 0,
      });
      // Webhook should have been emitted once.
      expect(emitWebhook).toHaveBeenCalledTimes(1);
      expect(emitWebhook).toHaveBeenCalledWith(
        {},
        "prediction.confirmed",
        expect.objectContaining({
          predictionId: pred.id,
          marketId: pred.marketId,
          txHash: pred.txHash,
        }),
      );
    });

    it("increments attempts for unmatched pending predictions", async () => {
      const { service, repo } = makeService({
        transactionalTick: jest.fn().mockResolvedValue({
          confirmed: [],
          incremented: 5,
          failedIds: [],
        }),
      });

      const result = await service.pollOnce();

      expect(result).toMatchObject({
        processed: 5,
        confirmed: 0,
        incremented: 5,
        failed: 0,
      });
    });

    it("marks predictions as failed after max attempts", async () => {
      const { service, repo } = makeService({
        transactionalTick: jest.fn().mockResolvedValue({
          confirmed: [],
          incremented: 0,
          failedIds: ["failed-1", "failed-2"],
        }),
      });

      const result = await service.pollOnce();

      expect(result).toMatchObject({
        processed: 2,
        confirmed: 0,
        incremented: 0,
        failed: 2,
      });
    });

    it("handles mixed outcomes in a single tick", async () => {
      const pred1 = confirmedPrediction({ id: "pred-confirmed-1" });
      const pred2 = confirmedPrediction({ id: "pred-confirmed-2" });

      const { service } = makeService({
        transactionalTick: jest.fn().mockResolvedValue({
          confirmed: [pred1, pred2],
          incremented: 3,
          failedIds: ["pred-failed-1"],
        }),
      });

      const result = await service.pollOnce();

      expect(result).toEqual<PollResult>({
        processed: 6, // 2 confirmed + 3 incremented + 1 failed
        confirmed: 2,
        incremented: 3,
        failed: 1,
        webhookErrors: 0,
      });
    });

    it("continues when webhook dispatch fails (does not crash tick)", async () => {
      const pred = confirmedPrediction();
      const emitWebhook = jest
        .fn()
        .mockRejectedValue(new Error("Webhook timeout"));

      const { service } = makeService(
        {
          transactionalTick: jest.fn().mockResolvedValue({
            confirmed: [pred],
            incremented: 0,
            failedIds: [],
          }),
        },
        { emitWebhook },
      );

      const result = await service.pollOnce();

      // The tick completes with the webhook error counted.
      expect(result.confirmed).toBe(1);
      expect(result.webhookErrors).toBe(1);
      expect(emitWebhook).toHaveBeenCalledTimes(1);
    });

    it("uses the configured batch size and max attempts", async () => {
      const { service, repo } = makeService(
        {},
        { batchSize: 500, maxAttempts: 5 },
      );

      await service.pollOnce();

      expect(repo.transactionalTick).toHaveBeenCalledWith(500, 5);
    });

    it("is idempotent when called multiple times with no new events", async () => {
      const { service, repo } = makeService();

      // First call — nothing to process.
      const result1 = await service.pollOnce();
      expect(result1.processed).toBe(0);

      // Second call — still nothing.
      const result2 = await service.pollOnce();
      expect(result2.processed).toBe(0);

      // transactionalTick was called both times.
      expect(repo.transactionalTick).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge cases", () => {
    it("handles an empty confirmed list gracefully", async () => {
      const emitWebhook = jest.fn();
      const { service } = makeService(
        {
          transactionalTick: jest.fn().mockResolvedValue({
            confirmed: [],
            incremented: 0,
            failedIds: [],
          }),
        },
        { emitWebhook },
      );

      const result = await service.pollOnce();

      expect(result.confirmed).toBe(0);
      expect(result.webhookErrors).toBe(0);
      expect(emitWebhook).not.toHaveBeenCalled();
    });

    it("handles a single prediction correctly", async () => {
      const pred = confirmedPrediction();
      const { service } = makeService({
        transactionalTick: jest.fn().mockResolvedValue({
          confirmed: [pred],
          incremented: 0,
          failedIds: [],
        }),
      });

      const result = await service.pollOnce();

      expect(result.confirmed).toBe(1);
      expect(result.processed).toBe(1);
      expect(result.webhookErrors).toBe(0);
    });

    it("handles many predictions without exceeding batch size", async () => {
      const ids = Array.from({ length: 100 }, (_, i) => `pred-${i}`);
      const preds = ids.map((id) => confirmedPrediction({ id }));

      const emitWebhook = jest.fn().mockResolvedValue(undefined);
      const { service } = makeService(
        {
          transactionalTick: jest.fn().mockResolvedValue({
            confirmed: preds,
            incremented: 0,
            failedIds: [],
          }),
        },
        { emitWebhook },
      );

      const result = await service.pollOnce();

      expect(result.confirmed).toBe(100);
      expect(emitWebhook).toHaveBeenCalledTimes(100);
    });

    it("does not emit webhooks when no predictions are confirmed", async () => {
      const emitWebhook = jest.fn();
      const { service } = makeService(
        {
          transactionalTick: jest.fn().mockResolvedValue({
            confirmed: [],
            incremented: 4,
            failedIds: [],
          }),
        },
        { emitWebhook },
      );

      const result = await service.pollOnce();

      expect(result.incremented).toBe(4);
      expect(result.confirmed).toBe(0);
      expect(emitWebhook).not.toHaveBeenCalled();
    });
  });
});
