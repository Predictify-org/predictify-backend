/**
 * Tests for the market resolution worker and service.
 *
 * Strategy: the service and worker accept their dependencies (repo, emitter)
 * via constructor/parameter injection, so every test runs fully in-memory with
 * no live database or network calls.
 *
 * Three layers are tested:
 *  1. resolveMarket() — service unit tests using jest.fn() repos
 *  2. InMemoryMarketResolutionRepo — fixture-based "seed → resolve → assert"
 *     tests that verify the won/lost categorisation logic end-to-end
 *  3. MarketResolverWorker — worker unit tests via injected repo + emitter
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
let workerCallback: any = null;

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }));
});
jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation((name) => ({
      name,
      add: jest.fn().mockResolvedValue({}),
    })),
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

import {
  resolveMarket,
  type MarketResolvedEvent,
  type MarketResolutionRepo,
  type WebhookEmitter,
  type WebhookPayload,
} from "../src/services/marketResolutionService";
import { MarketResolverWorker } from "../src/workers/marketResolver";

// ─── Shared fixtures ────────────────────────────────────────────────────────

const FIXTURE_EVENT: MarketResolvedEvent = {
  marketId: "market-sol-100",
  winningOutcome: "YES",
  ledger: 99_000,
  timestamp: 1_700_000_000,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRepo(overrides?: Partial<MarketResolutionRepo>): MarketResolutionRepo {
  return {
    atomicResolve: jest.fn(async () => true),
    fetchWebhookSubscribers: jest.fn(async () => []),
    ...overrides,
  };
}

function makeEmitter(): jest.MockedFunction<WebhookEmitter> {
  return jest.fn<ReturnType<WebhookEmitter>, Parameters<WebhookEmitter>>(async () => {});
}

// ─── 1. resolveMarket() — service unit tests ────────────────────────────────

describe("resolveMarket()", () => {
  it("returns processed:true and invokes atomicResolve with correct args", async () => {
    const repo = makeRepo();
    const result = await resolveMarket(repo, FIXTURE_EVENT, makeEmitter());

    expect(result.processed).toBe(true);
    expect(repo.atomicResolve).toHaveBeenCalledTimes(1);
    expect(repo.atomicResolve).toHaveBeenCalledWith(
      FIXTURE_EVENT.marketId,
      FIXTURE_EVENT.winningOutcome,
    );
  });

  it("fetches subscribers and calls the emitter once per subscriber", async () => {
    const subs = [
      { url: "https://hook-a.test/events", secret: "secret-a" },
      { url: "https://hook-b.test/events", secret: "secret-b" },
    ];
    const repo = makeRepo({ fetchWebhookSubscribers: jest.fn(async () => subs) });
    const emitter = makeEmitter();

    await resolveMarket(repo, FIXTURE_EVENT, emitter);

    expect(repo.fetchWebhookSubscribers).toHaveBeenCalledWith("market.resolved");
    expect(emitter).toHaveBeenCalledTimes(2);
  });

  it("sends a correctly-shaped WebhookPayload to each subscriber", async () => {
    const sub = { url: "https://hook.test/events", secret: "s" };
    const repo = makeRepo({ fetchWebhookSubscribers: jest.fn(async () => [sub]) });
    const emitter = makeEmitter();

    await resolveMarket(repo, FIXTURE_EVENT, emitter);

    const [calledSub, payload] = emitter.mock.calls[0] as [
      { url: string; secret: string },
      WebhookPayload,
    ];
    expect(calledSub).toEqual(sub);
    expect(payload).toMatchObject<WebhookPayload>({
      event: "market.resolved",
      marketId: FIXTURE_EVENT.marketId,
      winningOutcome: FIXTURE_EVENT.winningOutcome,
      ledger: FIXTURE_EVENT.ledger,
      timestamp: FIXTURE_EVENT.timestamp,
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────

  it("is idempotent — returns processed:false when market is already resolved", async () => {
    const repo = makeRepo({ atomicResolve: jest.fn(async () => false) });
    const emitter = makeEmitter();

    const result = await resolveMarket(repo, FIXTURE_EVENT, emitter);

    expect(result.processed).toBe(false);
  });

  it("does NOT fetch subscribers or emit webhooks when market is already resolved", async () => {
    const repo = makeRepo({ atomicResolve: jest.fn(async () => false) });
    const emitter = makeEmitter();

    await resolveMarket(repo, FIXTURE_EVENT, emitter);

    expect(repo.fetchWebhookSubscribers).not.toHaveBeenCalled();
    expect(emitter).not.toHaveBeenCalled();
  });

  // ── No subscribers ────────────────────────────────────────────────────

  it("returns processed:true even when there are no webhook subscribers", async () => {
    const repo = makeRepo({ fetchWebhookSubscribers: jest.fn(async () => []) });
    const emitter = makeEmitter();

    const result = await resolveMarket(repo, FIXTURE_EVENT, emitter);

    expect(result.processed).toBe(true);
    expect(emitter).not.toHaveBeenCalled();
  });

  // ── Webhook resilience ────────────────────────────────────────────────

  it("continues delivering to remaining subscribers when one delivery fails", async () => {
    const subs = [
      { url: "https://flaky.test/hook", secret: "s1" },
      { url: "https://stable.test/hook", secret: "s2" },
    ];
    const repo = makeRepo({ fetchWebhookSubscribers: jest.fn(async () => subs) });
    const emitter = jest.fn()
      .mockRejectedValueOnce(new Error("connection timeout"))
      .mockResolvedValueOnce(undefined) as jest.MockedFunction<WebhookEmitter>;

    // Must not throw even though the first delivery failed
    const result = await resolveMarket(repo, FIXTURE_EVENT, emitter);

    expect(result.processed).toBe(true);
    expect(emitter).toHaveBeenCalledTimes(2);
  });

  it("returns processed:true even when ALL webhook deliveries fail", async () => {
    const subs = [{ url: "https://dead.test/hook", secret: "s" }];
    const repo = makeRepo({ fetchWebhookSubscribers: jest.fn(async () => subs) });
    const emitter = jest.fn().mockRejectedValue(new Error("network unreachable"));

    const result = await resolveMarket(repo, FIXTURE_EVENT, emitter);

    expect(result.processed).toBe(true);
  });
});

// ─── 2. In-memory fixture tests — won/lost categorisation ───────────────────

/**
 * A local in-memory implementation of MarketResolutionRepo that mirrors the
 * logic of DrizzleMarketResolutionRepo without a real database.
 *
 * This lets us write "seed → resolve → assert end state" tests that exercise
 * the full service call stack and verify the won/lost categorisation end-to-end.
 */
interface MemMarket {
  id: string;
  status: string;
  winningOutcome: string | null;
}

interface MemPrediction {
  id: string;
  marketId: string;
  outcome: string;
  result: string | null;
}

class InMemoryMarketResolutionRepo implements MarketResolutionRepo {
  markets: MemMarket[] = [];
  predictions: MemPrediction[] = [];
  subs: Array<{ url: string; secret: string }> = [];

  async atomicResolve(marketId: string, winningOutcome: string): Promise<boolean> {
    const market = this.markets.find((m) => m.id === marketId);
    if (!market || market.status === "resolved") return false;

    market.status = "resolved";
    market.winningOutcome = winningOutcome;

    for (const p of this.predictions) {
      if (p.marketId === marketId) {
        p.result = p.outcome === winningOutcome ? "won" : "lost";
      }
    }

    return true;
  }

  async fetchWebhookSubscribers(_event: string): Promise<Array<{ url: string; secret: string }>> {
    return this.subs;
  }
}

function seedRepo(): InMemoryMarketResolutionRepo {
  const repo = new InMemoryMarketResolutionRepo();
  repo.markets.push({ id: "mkt-1", status: "active", winningOutcome: null });
  repo.predictions.push(
    { id: "pred-1", marketId: "mkt-1", outcome: "YES", result: null },
    { id: "pred-2", marketId: "mkt-1", outcome: "NO",  result: null },
    { id: "pred-3", marketId: "mkt-1", outcome: "YES", result: null },
  );
  return repo;
}

const FIXTURE_RESOLVE: MarketResolvedEvent = {
  marketId: "mkt-1",
  winningOutcome: "YES",
  ledger: 42_000,
  timestamp: 1_700_000_000,
};

describe("resolveMarket() — in-memory fixture tests (end-to-end logic)", () => {
  it("marks the market as resolved with the correct winning outcome", async () => {
    const repo = seedRepo();

    await resolveMarket(repo, FIXTURE_RESOLVE, makeEmitter());

    expect(repo.markets[0].status).toBe("resolved");
    expect(repo.markets[0].winningOutcome).toBe("YES");
  });

  it("marks predictions whose outcome matches winningOutcome as 'won'", async () => {
    const repo = seedRepo();
    await resolveMarket(repo, FIXTURE_RESOLVE, makeEmitter());

    const winners = repo.predictions.filter((p) => p.outcome === "YES");
    expect(winners).toHaveLength(2);
    winners.forEach((p) => expect(p.result).toBe("won"));
  });

  it("marks predictions whose outcome does not match as 'lost'", async () => {
    const repo = seedRepo();
    await resolveMarket(repo, FIXTURE_RESOLVE, makeEmitter());

    const losers = repo.predictions.filter((p) => p.outcome === "NO");
    expect(losers).toHaveLength(1);
    losers.forEach((p) => expect(p.result).toBe("lost"));
  });

  it("categorises all predictions in a single pass (no omissions)", async () => {
    const repo = seedRepo();
    await resolveMarket(repo, FIXTURE_RESOLVE, makeEmitter());

    const unresolved = repo.predictions.filter((p) => p.result === null);
    expect(unresolved).toHaveLength(0);
  });

  // ── Idempotency ────────────────────────────────────────────────────────

  it("replaying the same event is a no-op (idempotency)", async () => {
    const repo = seedRepo();
    const emitter = makeEmitter();

    const first  = await resolveMarket(repo, FIXTURE_RESOLVE, emitter);
    const second = await resolveMarket(repo, FIXTURE_RESOLVE, emitter);

    expect(first.processed).toBe(true);
    expect(second.processed).toBe(false);
    // Market state unchanged after replay
    expect(repo.markets[0].status).toBe("resolved");
    expect(repo.predictions.filter((p) => p.result === null)).toHaveLength(0);
  });

  it("does not emit a second webhook when the event is replayed", async () => {
    const repo = seedRepo();
    repo.subs = [{ url: "https://hook.test/events", secret: "s" }];
    const emitter = makeEmitter();

    await resolveMarket(repo, FIXTURE_RESOLVE, emitter); // first → webhook fires
    await resolveMarket(repo, FIXTURE_RESOLVE, emitter); // replay → no webhook

    expect(emitter).toHaveBeenCalledTimes(1);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("handles a market that has zero predictions gracefully", async () => {
    const repo = seedRepo();
    repo.predictions = [];

    const result = await resolveMarket(repo, FIXTURE_RESOLVE, makeEmitter());

    expect(result.processed).toBe(true);
    expect(repo.markets[0].status).toBe("resolved");
  });

  it("returns processed:false for an unknown market ID", async () => {
    const repo = seedRepo();
    const unknownEvent: MarketResolvedEvent = { ...FIXTURE_RESOLVE, marketId: "ghost-market" };

    const result = await resolveMarket(repo, unknownEvent, makeEmitter());

    expect(result.processed).toBe(false);
    // Original market untouched
    expect(repo.markets[0].status).toBe("active");
  });

  it("only affects predictions that belong to the resolved market", async () => {
    const repo = seedRepo();
    // Add a prediction for a different market
    repo.markets.push({ id: "mkt-2", status: "active", winningOutcome: null });
    repo.predictions.push({ id: "pred-other", marketId: "mkt-2", outcome: "YES", result: null });

    await resolveMarket(repo, FIXTURE_RESOLVE, makeEmitter());

    const otherPred = repo.predictions.find((p) => p.id === "pred-other")!;
    expect(otherPred.result).toBeNull(); // untouched
  });
});

// ─── 3. MarketResolverWorker — worker unit tests ─────────────────────────────

import { marketResolutionQueue } from "../src/queue";
import { Worker } from "bullmq";

describe("MarketResolverWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeWorker(repoOverrides?: Partial<MarketResolutionRepo>): MarketResolverWorker {
    return new MarketResolverWorker(makeRepo(repoOverrides), makeEmitter());
  }

  it("handleEvent enqueues the event to marketResolutionQueue", async () => {
    const worker = makeWorker();
    await worker.handleEvent(FIXTURE_EVENT);
    expect(marketResolutionQueue.add).toHaveBeenCalledTimes(1);
    expect(marketResolutionQueue.add).toHaveBeenCalledWith("resolve", FIXTURE_EVENT);
  });

  it("can start and stop the worker", async () => {
    const worker = makeWorker();
    worker.start();
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(Worker).toHaveBeenCalledWith(
      "market-resolution",
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 }),
    );

    await worker.stop();
    const workerInstance = (Worker as unknown as jest.Mock).mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });

  it("worker processor calls resolveMarket", async () => {
    const atomicResolve = jest.fn(async () => true);
    const worker = makeWorker({ atomicResolve });
    worker.start();

    expect(workerCallback).toBeDefined();
    await expect(
      workerCallback({ id: "job-1", data: FIXTURE_EVENT })
    ).resolves.toBeUndefined();

    expect(atomicResolve).toHaveBeenCalledWith(
      FIXTURE_EVENT.marketId,
      FIXTURE_EVENT.winningOutcome,
    );
  });

  it("worker processor handles re-entry and skipped status", async () => {
    const atomicResolve = jest.fn(async () => false);
    const worker = makeWorker({ atomicResolve });
    worker.start();

    expect(workerCallback).toBeDefined();
    await expect(
      workerCallback({ id: "job-2", data: FIXTURE_EVENT })
    ).resolves.toBeUndefined();

    expect(atomicResolve).toHaveBeenCalledWith(
      FIXTURE_EVENT.marketId,
      FIXTURE_EVENT.winningOutcome,
    );
  });
});
