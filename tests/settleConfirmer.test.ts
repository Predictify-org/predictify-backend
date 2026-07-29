import {
  SettleConfirmerService,
  HttpHorizonClient,
  calculateNextRetry,
  SETTLE_BACKOFF_MS,
  MAX_SETTLE_ATTEMPTS,
  type SettleConfirmerRepo,
  type HorizonClient,
  type PendingClaim,
} from "../src/services/settleConfirmerService";

// ─── Constants tests ─────────────────────────────────────────────────────────

describe("SETTLE_BACKOFF_MS", () => {
  it("has a defined length matching MAX_SETTLE_ATTEMPTS", () => {
    expect(SETTLE_BACKOFF_MS.length).toBe(MAX_SETTLE_ATTEMPTS);
  });

  it("has monotonically increasing backoff intervals", () => {
    for (let i = 1; i < SETTLE_BACKOFF_MS.length; i++) {
      expect(SETTLE_BACKOFF_MS[i]).toBeGreaterThan(SETTLE_BACKOFF_MS[i - 1]);
    }
  });
});

describe("calculateNextRetry", () => {
  it("returns a future date for attempts < MAX_SETTLE_ATTEMPTS", () => {
    const now = Date.now();
    const result = calculateNextRetry(0);
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBeGreaterThan(now);
  });

  it("uses the correct backoff delay for each attempt index", () => {
    const before = Date.now();
    const result = calculateNextRetry(0);
    expect(result).not.toBeNull();
    const expectedDelay = SETTLE_BACKOFF_MS[0];
    const actualDelay = result!.getTime() - before;
    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - 5);
    expect(actualDelay).toBeLessThanOrEqual(expectedDelay + 50);
  });

  it("returns null for attempts == MAX_SETTLE_ATTEMPTS (terminal)", () => {
    expect(calculateNextRetry(MAX_SETTLE_ATTEMPTS)).toBeNull();
  });

  it("returns null for attempts > MAX_SETTLE_ATTEMPTS", () => {
    expect(calculateNextRetry(MAX_SETTLE_ATTEMPTS + 5)).toBeNull();
  });

  it("uses the last backoff value for the MAX_SETTLE_ATTEMPTS - 1 index", () => {
    const before = Date.now();
    const result = calculateNextRetry(MAX_SETTLE_ATTEMPTS - 1);
    expect(result).not.toBeNull();
    const expectedDelay = SETTLE_BACKOFF_MS[MAX_SETTLE_ATTEMPTS - 1];
    const actualDelay = result!.getTime() - before;
    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - 5);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRepo(overrides?: Partial<SettleConfirmerRepo>): SettleConfirmerRepo {
  return {
    getPendingSettlements: jest.fn(async () => []),
    markSettled: jest.fn(async () => {}),
    scheduleRetry: jest.fn(async () => {}),
    markFailed: jest.fn(async () => {}),
    ...overrides,
  };
}

type MockHorizonClient = {
  [K in keyof HorizonClient]: jest.Mock<ReturnType<HorizonClient[K]>, Parameters<HorizonClient[K]>>;
};

function makeHorizon(overrides?: Partial<MockHorizonClient>): MockHorizonClient {
  return {
    getTransaction: jest.fn(async () => ({ successful: true, ledger: 100 })),
    getCurrentLedger: jest.fn(async () => 105),
    ...overrides,
  } as MockHorizonClient;
}

function makeService(
  repoOverrides?: Partial<SettleConfirmerRepo>,
  horizonOverrides?: Partial<MockHorizonClient>,
  confirmationLedgers = 2,
): {
  service: SettleConfirmerService;
  repo: SettleConfirmerRepo;
  horizon: MockHorizonClient;
} {
  const repo = makeRepo(repoOverrides);
  const horizon = makeHorizon(horizonOverrides);
  const service = new SettleConfirmerService(repo, horizon, confirmationLedgers);
  return { service, repo, horizon };
}

function pendingClaim(overrides?: Partial<PendingClaim>): PendingClaim {
  return {
    id: "claim-1",
    settlementTx: "abc123",
    settleAttempts: 0,
    ...overrides,
  };
}

// ─── SettleConfirmerService — pollOnce ────────────────────────────────────────

describe("SettleConfirmerService.pollOnce()", () => {
  it("returns zeros when there are no pending claims", async () => {
    const { service, repo } = makeService();
    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([]);

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 0, settled: 0, failed: 0 });
  });

  it("marks a claim as settled when the tx is successful and has enough confirmations", async () => {
    const claim = pendingClaim();
    const { service, repo, horizon } = makeService({}, {}, 2);

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([claim]);
    horizon.getTransaction.mockResolvedValue({ successful: true, ledger: 100 });
    horizon.getCurrentLedger.mockResolvedValue(102); // 102 - 100 = 2 confirmations

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 1, settled: 1, failed: 0 });
    expect(repo.markSettled).toHaveBeenCalledWith("claim-1", expect.any(Date));
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });

  it("does NOT settle when confirmations are below the threshold and schedules a retry", async () => {
    const claim = pendingClaim();
    const { service, repo, horizon } = makeService({}, {}, 5);

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([claim]);
    horizon.getTransaction.mockResolvedValue({ successful: true, ledger: 100 });
    horizon.getCurrentLedger.mockResolvedValue(103); // 103 - 100 = 3 < 5

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 1, settled: 0, failed: 0 });
    expect(repo.markSettled).not.toHaveBeenCalled();
    expect(repo.scheduleRetry).toHaveBeenCalledWith(
      "claim-1",
      expect.any(Date),
      1,
    );
  });

  it("marks a claim as failed when the tx was not successful on-chain", async () => {
    const claim = pendingClaim();
    const { service, repo, horizon } = makeService();

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([claim]);
    horizon.getTransaction.mockResolvedValue({ successful: false, ledger: 100 });
    horizon.getCurrentLedger.mockResolvedValue(105);

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 1, settled: 0, failed: 1 });
    expect(repo.markSettled).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith("claim-1");
  });

  it("schedules a retry when Horizon throws an error and max attempts not yet reached", async () => {
    const claim = pendingClaim({ settleAttempts: 0 });
    const { service, repo, horizon } = makeService();

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([claim]);
    horizon.getTransaction.mockRejectedValue(new Error("Horizon timeout"));

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 1, settled: 0, failed: 0 });
    expect(repo.scheduleRetry).toHaveBeenCalledWith(
      "claim-1",
      expect.any(Date),
      1,
    );
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("marks a claim as failed when Horizon errors and max attempts reached", async () => {
    const claim = pendingClaim({ settleAttempts: MAX_SETTLE_ATTEMPTS - 1 }); // last attempt
    const { service, repo, horizon } = makeService();

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([claim]);
    horizon.getTransaction.mockRejectedValue(new Error("Horizon timeout"));

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 1, settled: 0, failed: 1 });
    expect(repo.markFailed).toHaveBeenCalledWith("claim-1");
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });

  it("marks as failed when not enough confirmations on the last allowed attempt", async () => {
    const claim = pendingClaim({ settleAttempts: MAX_SETTLE_ATTEMPTS - 1 });
    const { service, repo, horizon } = makeService({}, {}, 10);

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([claim]);
    horizon.getTransaction.mockResolvedValue({ successful: true, ledger: 100 });
    horizon.getCurrentLedger.mockResolvedValue(105); // 5 < 10

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 1, settled: 0, failed: 1 });
    expect(repo.markFailed).toHaveBeenCalledWith("claim-1");
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });

  it("processes multiple claims with mixed outcomes", async () => {
    const claims_list = [
      pendingClaim({ id: "settled-1", settlementTx: "tx1", settleAttempts: 1 }),
      pendingClaim({ id: "retried-1", settlementTx: "tx2", settleAttempts: 0 }),
      pendingClaim({ id: "failed-1", settlementTx: "tx3", settleAttempts: 0 }),
    ];
    const { service, repo, horizon } = makeService({}, {}, 2);

    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue(claims_list);
    horizon.getTransaction
      .mockResolvedValueOnce({ successful: true, ledger: 100 })  // settled-1
      .mockResolvedValueOnce({ successful: true, ledger: 100 })  // retried-1
      .mockResolvedValueOnce({ successful: false, ledger: 100 }); // failed-1
    horizon.getCurrentLedger
      .mockResolvedValueOnce(105) // enough confirmations
      .mockResolvedValueOnce(101) // only 1 confirmation < 2
      .mockResolvedValueOnce(105); // N/A for failed tx

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 3, settled: 1, failed: 1 });
    expect(repo.markSettled).toHaveBeenCalledWith("settled-1", expect.any(Date));
    expect(repo.scheduleRetry).toHaveBeenCalledWith("retried-1", expect.any(Date), 1);
    expect(repo.markFailed).toHaveBeenCalledWith("failed-1");
  });

  it("handles an empty pending list gracefully", async () => {
    const { service, repo } = makeService();
    jest.spyOn(repo, "getPendingSettlements").mockResolvedValue([]);

    const result = await service.pollOnce();

    expect(result).toEqual({ processed: 0, settled: 0, failed: 0 });
    expect(repo.markSettled).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });
});

// ─── HttpHorizonClient ───────────────────────────────────────────────────────

describe("HttpHorizonClient", () => {
  const baseUrl = "https://horizon-testnet.stellar.org";

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe("getTransaction", () => {
    it("returns TransactionInfo when the tx exists and is successful", async () => {
      const mockResponse = { successful: true, ledger: 12345 };
      jest.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const client = new HttpHorizonClient(baseUrl);
      const result = await client.getTransaction("somehash");

      expect(result).toEqual({ successful: true, ledger: 12345 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${baseUrl}/transactions/somehash`,
      );
    });

    it("returns TransactionInfo when the tx exists and is NOT successful", async () => {
      const mockResponse = { successful: false, ledger: 12345 };
      jest.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const client = new HttpHorizonClient(baseUrl);
      const result = await client.getTransaction("failedhash");

      expect(result).toEqual({ successful: false, ledger: 12345 });
    });

    it("throws with a descriptive message on HTTP 404", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const client = new HttpHorizonClient(baseUrl);
      await expect(client.getTransaction("unknown")).rejects.toThrow(
        "Transaction not found: unknown",
      );
    });

    it("throws on non-OK status codes", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const client = new HttpHorizonClient(baseUrl);
      await expect(client.getTransaction("errorhash")).rejects.toThrow(
        /Horizon transaction lookup failed: HTTP 500/,
      );
    });
  });

  describe("getCurrentLedger", () => {
    it("returns the core_latest_ledger from the Horizon root endpoint", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ core_latest_ledger: 99999 }),
      } as Response);

      const client = new HttpHorizonClient(baseUrl);
      const result = await client.getCurrentLedger();

      expect(result).toBe(99999);
      expect(globalThis.fetch).toHaveBeenCalledWith(baseUrl);
    });

    it("throws on a failed root request", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);

      const client = new HttpHorizonClient(baseUrl);
      await expect(client.getCurrentLedger()).rejects.toThrow(
        /Horizon root request failed: HTTP 503/,
      );
    });
  });

  it("strips trailing slashes from the base URL", () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const withSlash = new HttpHorizonClient("https://horizon.test/");
    withSlash.getCurrentLedger();
    expect(globalThis.fetch).toHaveBeenCalledWith("https://horizon.test");
    // trailing-slash and no-slash URLs resolve to the same endpoint
    const noSlash = new HttpHorizonClient("https://horizon.test");
    noSlash.getCurrentLedger();
    expect(globalThis.fetch).toHaveBeenLastCalledWith("https://horizon.test");
  });
});
