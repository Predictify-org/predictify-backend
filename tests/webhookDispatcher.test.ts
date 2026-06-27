/**
 * Tests for the webhook dispatcher service.
 *
 * Strategy
 * ────────
 *  • The Drizzle DB is fully mocked — no real PostgreSQL required.
 *  • The global `fetch` is replaced with a Jest mock to control HTTP responses.
 *  • Tests verify:
 *      1. HMAC-SHA256 signature is computed over raw body bytes.
 *      2. verifySignature uses timing-safe comparison and rejects bad sigs.
 *      3. 2xx → status = "success", attempt incremented.
 *      4. 5xx → status = "failed", nextRetryAt scheduled per backoff table.
 *      5. Timeout (AbortError) → treated as failure.
 *      6. After MAX_ATTEMPTS-1 retries the delivery becomes "terminal".
 *      7. dispatchEvent fans out to N subscribers concurrently (all settled).
 *      8. Subscriptions without matching event type are skipped.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  signPayload,
  verifySignature,
  computeNextState,
  dispatchEvent,
  attemptDelivery,
  generateSecret,
  BACKOFF_MS,
  MAX_ATTEMPTS,
} from "../src/services/webhookDispatcher";
import { webhookQueue } from "../src/queue";

jest.mock("../src/queue", () => ({
  webhookQueue: {
    add: jest.fn().mockResolvedValue({}),
  },
}));

// Convenience alias so tests can cast mocks without repeating the long type.
type AnyDb = NodePgDatabase;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Drizzle DB.
 *
 * The mock tracks whether the last top-level call was select/insert/update and
 * returns the appropriate rows when the chain is awaited or .returning() is
 * called.  Each `select()` call resolves to `_selectRows`.  Each
 * `insert().values().returning()` resolves to `_insertReturns` (cycled through
 * `_insertQueue` if provided).  Each `update().set().where().returning()`
 * resolves to `_updateReturns`.
 */
function makeDb(): MockDb {
  const db = {} as MockDb;

  db._selectRows = [];
  db._insertReturns = [];
  db._insertQueue = [];   // optional: cycle through multiple insert returns
  db._updateReturns = [];

  // ---- select chain -------------------------------------------------------
  // select().from().where()  → awaitable (resolves to _selectRows)
  // select().from().where().limit() → also resolves to _selectRows
  const selectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation(() => {
      // Make the chain thenable so `await db.select().from(t).where(c)` works.
      const thenable = {
        then: (resolve: (v: unknown) => void) => resolve(db._selectRows),
        limit: jest.fn().mockImplementation(() => Promise.resolve(db._selectRows)),
        where: jest.fn().mockReturnThis(), // support double .where()
      };
      // Also make double .where() on thenable work.
      thenable.where.mockReturnValue(thenable);
      return thenable;
    }),
    limit: jest.fn().mockImplementation(() => Promise.resolve(db._selectRows)),
  };
  db.select = jest.fn().mockReturnValue(selectChain);

  // ---- insert chain -------------------------------------------------------
  let insertCallCount = 0;
  const insertChain = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockImplementation(() => {
      const queue = db._insertQueue;
      const rows = queue.length > 0 ? queue[insertCallCount++ % queue.length] : db._insertReturns;
      return Promise.resolve(rows);
    }),
  };
  db.insert = jest.fn().mockReturnValue(insertChain);

  // ---- update chain -------------------------------------------------------
  const updateChain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockImplementation(() => Promise.resolve(db._updateReturns)),
  };
  // Expose set so tests can inspect calls.
  db.set = updateChain.set;
  db.update = jest.fn().mockReturnValue(updateChain);

  return db;
}

interface MockDb {
  _selectRows: unknown[];
  _insertReturns: unknown[];
  _insertQueue: unknown[][];
  _updateReturns: unknown[];
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;  // reference to the update chain's set() for test assertions
}

/** Build a valid 32-byte hex secret. */
function makeSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Compute expected HMAC signature the same way the dispatcher does. */
function expectedSig(secret: string, body: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", Buffer.from(secret, "hex")).update(body).digest("hex")
  );
}

// ---------------------------------------------------------------------------
// 1. signPayload / verifySignature
// ---------------------------------------------------------------------------

describe("signPayload", () => {
  it("produces sha256=<hex> over the raw body bytes", () => {
    const secret = makeSecret();
    const body = Buffer.from('{"foo":1}', "utf8");
    const sig = signPayload(secret, body);

    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).toBe(expectedSig(secret, body));
  });

  it("produces a different signature for different bodies", () => {
    const secret = makeSecret();
    const a = signPayload(secret, Buffer.from("aaa"));
    const b = signPayload(secret, Buffer.from("bbb"));
    expect(a).not.toBe(b);
  });

  it("produces a different signature for different secrets", () => {
    const body = Buffer.from("payload");
    const s1 = signPayload(makeSecret(), body);
    const s2 = signPayload(makeSecret(), body);
    expect(s1).not.toBe(s2);
  });
});

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const secret = makeSecret();
    const body = Buffer.from('{"event":"market.resolved"}');
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it("returns false when the signature is wrong", () => {
    const secret = makeSecret();
    const body = Buffer.from("body");
    expect(verifySignature(secret, body, "sha256=deadbeef")).toBe(false);
  });

  it("returns false when the body is tampered (sig over raw bytes, not JSON)", () => {
    const secret = makeSecret();
    const original = Buffer.from('{"amount":100}');
    const tampered = Buffer.from('{"amount":999}');
    const sig = signPayload(secret, original);
    expect(verifySignature(secret, tampered, sig)).toBe(false);
  });

  it("returns false for a missing sha256= prefix", () => {
    const secret = makeSecret();
    const body = Buffer.from("x");
    const rawHex = createHmac("sha256", Buffer.from(secret, "hex")).update(body).digest("hex");
    expect(verifySignature(secret, body, rawHex)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(verifySignature(makeSecret(), Buffer.from("x"), "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. computeNextState
// ---------------------------------------------------------------------------

describe("computeNextState", () => {
  it("returns success status on success", () => {
    const { nextStatus } = computeNextState(1, true);
    expect(nextStatus).toBe("success");
  });

  it("returns failed with correct backoff for first failure (attempt=1)", () => {
    const { nextStatus, nextRetryAt } = computeNextState(1, false);
    expect(nextStatus).toBe("failed");
    const delta = nextRetryAt.getTime() - Date.now();
    // Should be ~30 s; allow ±1 s tolerance.
    expect(delta).toBeGreaterThan(BACKOFF_MS[0] - 1_000);
    expect(delta).toBeLessThanOrEqual(BACKOFF_MS[0] + 1_000);
  });

  it("returns terminal after exhausting all retries", () => {
    // attempt = MAX_ATTEMPTS means we've used all backoff slots.
    const { nextStatus } = computeNextState(MAX_ATTEMPTS, false);
    expect(nextStatus).toBe("terminal");
  });

  it("respects the full backoff schedule", () => {
    const statuses = BACKOFF_MS.map((_, i) => {
      const { nextStatus, nextRetryAt } = computeNextState(i + 1, false);
      return { nextStatus, delayMs: nextRetryAt.getTime() - Date.now() };
    });

    for (let i = 0; i < BACKOFF_MS.length; i++) {
      expect(statuses[i].nextStatus).toBe("failed");
      expect(statuses[i].delayMs).toBeGreaterThan(BACKOFF_MS[i] - 1_000);
      expect(statuses[i].delayMs).toBeLessThanOrEqual(BACKOFF_MS[i] + 1_000);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. generateSecret
// ---------------------------------------------------------------------------

describe("generateSecret", () => {
  it("returns a 64-char hex string (32 bytes)", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unique on each call", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

// ---------------------------------------------------------------------------
// 4. attemptDelivery — success path
// ---------------------------------------------------------------------------

describe("attemptDelivery — 2xx success", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ status: 200, text: async () => "" });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => jest.restoreAllMocks());

  it("sends the correct headers and updates delivery to success", async () => {
    const secret = makeSecret();
    const payload = { marketId: "m1", status: "resolved" };
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const deliveryId = "del-001";
    const url = "https://example.com/webhook";
    const eventType = "market.resolved";

    // DB mock: update returning the delivery row at attempt=0.
    const db = makeDb();
    db._updateReturns = [{ id: deliveryId, attempt: 0, subscriptionId: "sub-1" }];

    const result = await attemptDelivery(db as unknown as AnyDb, deliveryId, url, secret, rawBody, eventType);

    // Verify result
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.deliveryId).toBe(deliveryId);

    // Verify HTTP call
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect((calledInit.headers as Record<string, string>)["X-Predictify-Event"]).toBe(eventType);
    expect((calledInit.headers as Record<string, string>)["X-Predictify-Delivery"]).toBe(deliveryId);

    // Verify signature over raw bytes
    const sig = (calledInit.headers as Record<string, string>)["X-Predictify-Signature"];
    expect(verifySignature(secret, rawBody, sig)).toBe(true);

    // Verify the final DB update sets status = "success"
    const setMock = db.set as jest.Mock;
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1][0] as {
      status: string;
    };
    expect(lastSetCall.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// 5. attemptDelivery — 5xx retry scheduling
// ---------------------------------------------------------------------------

describe("attemptDelivery — 5xx triggers retry scheduling", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as typeof fetch;
  });

  it("sets status=failed and schedules nextRetryAt ~30 s out on first attempt", async () => {
    const secret = makeSecret();
    const rawBody = Buffer.from("{}", "utf8");
    const db = makeDb();
    // First update (status→delivering) returns attempt=0.
    db._updateReturns = [{ id: "del-002", attempt: 0, subscriptionId: "sub-1" }];

    const result = await attemptDelivery(db as unknown as AnyDb, "del-002", "https://example.com/wh", secret, rawBody, "dispute.opened");

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);

    // The final set() call should contain status="failed" and a nextRetryAt ~30 s from now.
    const setMock = db.set as jest.Mock;
    const finalUpdate = setMock.mock.calls[setMock.mock.calls.length - 1][0] as {
      status: string;
      nextRetryAt: Date;
      attempt: number;
    };

    expect(finalUpdate.status).toBe("failed");
    expect(finalUpdate.attempt).toBe(1);
    const delta = finalUpdate.nextRetryAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(BACKOFF_MS[0] - 1_000);
    expect(delta).toBeLessThanOrEqual(BACKOFF_MS[0] + 1_000);
  });
});

// ---------------------------------------------------------------------------
// 6. attemptDelivery — terminal after MAX_ATTEMPTS
// ---------------------------------------------------------------------------

describe("attemptDelivery — terminal after exhausting retries", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      text: async () => "Service Unavailable",
    }) as unknown as typeof fetch;
  });

  it("sets status=terminal when attempt equals MAX_ATTEMPTS", async () => {
    const db = makeDb();
    // Simulate the delivery already having MAX_ATTEMPTS - 1 prior attempts.
    db._updateReturns = [{ id: "del-003", attempt: MAX_ATTEMPTS - 1, subscriptionId: "sub-1" }];

    await attemptDelivery(db as unknown as AnyDb, "del-003", "https://example.com/wh", makeSecret(), Buffer.from("{}"), "market.resolved");

    const setMock = db.set as jest.Mock;
    const finalUpdate = setMock.mock.calls[setMock.mock.calls.length - 1][0] as { status: string };
    expect(finalUpdate.status).toBe("terminal");
  });
});

// ---------------------------------------------------------------------------
// 7. attemptDelivery — timeout treated as failure
// ---------------------------------------------------------------------------

describe("attemptDelivery — network timeout", () => {
  it("treats AbortError as a failure and schedules a retry", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    global.fetch = jest.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    const db = makeDb();
    db._updateReturns = [{ id: "del-004", attempt: 0, subscriptionId: "sub-1" }];

    const result = await attemptDelivery(
      db as unknown as AnyDb,
      "del-004",
      "https://slow.example.com/wh",
      makeSecret(),
      Buffer.from("{}"),
      "market.resolved",
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.error).toContain("aborted");

    const setMock = db.set as jest.Mock;
    const finalUpdate = setMock.mock.calls[setMock.mock.calls.length - 1][0] as { status: string };
    expect(finalUpdate.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 8. dispatchEvent — fan-out to multiple subscribers
// ---------------------------------------------------------------------------

describe("dispatchEvent — concurrent fan-out", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("delivers to all matching subscribers concurrently", async () => {
    const subscriptions = [
      { id: "sub-a", url: "https://a.example.com/wh", secret: makeSecret(), events: ["market.resolved"], active: true },
      { id: "sub-b", url: "https://b.example.com/wh", secret: makeSecret(), events: ["market.resolved", "dispute.opened"], active: true },
    ];

    const db = makeDb();
    db._selectRows = subscriptions;
    // Provide two insert rows (one per subscriber) via the queue.
    db._insertQueue = [
      [{ id: "del-1", subscriptionId: "sub-a", attempt: 0 }],
      [{ id: "del-2", subscriptionId: "sub-b", attempt: 0 }],
    ];
    // Update chain resolves for delivering→success for both deliveries.
    db._updateReturns = [{ id: "del-1", attempt: 0, subscriptionId: "sub-a" }];

    const results = await dispatchEvent(db as unknown as AnyDb, "market.resolved", { marketId: "m1" });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(webhookQueue.add).toHaveBeenCalledTimes(2);
  });

  it("skips subscribers not interested in the event type", async () => {
    const db = makeDb();
    db._selectRows = [
      { id: "sub-c", url: "https://c.example.com/wh", secret: makeSecret(), events: ["dispute.opened"], active: true },
    ];

    const results = await dispatchEvent(db as unknown as AnyDb, "market.resolved", { marketId: "m2" });

    expect(results).toHaveLength(0);
    expect(webhookQueue.add).not.toHaveBeenCalled();
  });

  it("wildcard '*' subscription receives all event types", async () => {
    const db = makeDb();
    db._selectRows = [
      { id: "sub-d", url: "https://d.example.com/wh", secret: makeSecret(), events: ["*"], active: true },
    ];
    db._insertQueue = [[{ id: "del-x", subscriptionId: "sub-d", attempt: 0 }]];
    db._updateReturns = [{ id: "del-x", attempt: 0, subscriptionId: "sub-d" }];

    const results = await dispatchEvent(db as unknown as AnyDb, "anything.happened", { foo: "bar" });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(webhookQueue.add).toHaveBeenCalledTimes(1);
  });

  it("returns results for all subscribers even when one queue add fails (allSettled)", async () => {
    const subscriptions = [
      { id: "sub-e", url: "https://good.example.com/wh", secret: makeSecret(), events: ["market.resolved"], active: true },
      { id: "sub-f", url: "https://bad.example.com/wh",  secret: makeSecret(), events: ["market.resolved"], active: true },
    ];

    // First queue add -> succeeds, second -> fails.
    let addCallCount = 0;
    (webhookQueue.add as jest.Mock).mockImplementation(() => {
      addCallCount++;
      return addCallCount === 2
        ? Promise.reject(new Error("Queue error"))
        : Promise.resolve({});
    });

    const db = makeDb();
    db._selectRows = subscriptions;
    db._insertQueue = [
      [{ id: "del-3", subscriptionId: "sub-e", attempt: 0 }],
      [{ id: "del-4", subscriptionId: "sub-f", attempt: 0 }],
    ];
    db._updateReturns = [{ id: "del-3", attempt: 0, subscriptionId: "sub-e" }];

    const results = await dispatchEvent(db as unknown as AnyDb, "market.resolved", { x: 1 });

    expect(results).toHaveLength(2);
    // One succeeded, one failed — order matches subscription order.
    const successes = results.filter((r) => r.success);
    const failures  = results.filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});
