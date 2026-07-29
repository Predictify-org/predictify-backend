/**
 * commentsCircuitBreaker.test.ts
 *
 * Focused tests for the per-endpoint circuit breaker on /api/comments.
 *
 * Test coverage:
 *
 * Part 1 — CircuitBreaker state machine (lib/circuitBreaker.ts)
 *   - CLOSED: passes through calls, records failures, opens on threshold
 *   - OPEN: fast-fails with CircuitOpenError, transitions to HALF_OPEN
 *   - HALF_OPEN: allows one probe; success → CLOSED, failure → OPEN
 *   - Rolling window: failures older than windowMs are discarded
 *
 * Part 2 — Route integration (routes/comments.ts)
 *   - GET /:id/comments returns 503 when commentsDbBreaker is OPEN
 *   - POST /        returns 503 when commentsOutboundBreaker is OPEN
 *   - Normal requests still succeed when breakers are CLOSED
 */

// ── Module-level mocks ────────────────────────────────────────────────────────

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../src/services/marketCommentsService", () => ({
  listMarketComments: jest.fn(),
}));

jest.mock("../src/middleware/correlation", () => ({
  correlationMiddleware: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
  getCorrelationId: jest.fn().mockReturnValue("test-corr-id"),
  CORRELATION_ID_HEADER: "x-correlation-id",
  fetchWithCorrelationId: jest.fn(),
}));

jest.mock("../src/middleware/rateLimitAnon", () => ({
  rateLimitAnon: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));

jest.mock("../src/middleware/cors", () => ({
  marketsCors: () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) => next(),
}));

jest.mock("../src/lib/requestContext", () => ({
  getRequestId: jest.fn().mockReturnValue("test-req-id"),
  requestContextStorage: { getStore: jest.fn().mockReturnValue(null) },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import { CircuitBreaker, CircuitOpenError } from "../src/lib/circuitBreaker";
import { listMarketComments } from "../src/services/marketCommentsService";
import { fetchWithCorrelationId } from "../src/middleware/correlation";
import {
  commentsRouter,
  commentsDbBreaker,
  commentsOutboundBreaker,
} from "../src/routes/comments";

const mockListMarketComments = listMarketComments as jest.Mock;
const mockFetch = fetchWithCorrelationId as jest.Mock;

const ALLOWED_ORIGIN = "http://localhost:5173";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/markets", commentsRouter);
  app.use("/api/comments", commentsRouter);
  return app;
}

// ── Part 1: CircuitBreaker state machine unit tests ───────────────────────────

describe("CircuitBreaker — state machine", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    // Short thresholds to make tests fast
    breaker = new CircuitBreaker("test-breaker", {
      failureThreshold: 3,
      windowMs: 10_000,
      resetTimeoutMs: 50, // 50 ms so tests can wait for HALF_OPEN
    });
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it("starts in CLOSED state", () => {
    expect(breaker.state).toBe("CLOSED");
  });

  // ── CLOSED → passes through ────────────────────────────────────────────────

  it("passes through a successful call when CLOSED", async () => {
    const result = await breaker.fire(async () => "ok");
    expect(result).toBe("ok");
    expect(breaker.state).toBe("CLOSED");
  });

  it("re-throws errors from the callable when CLOSED", async () => {
    const boom = new Error("downstream blew up");
    await expect(breaker.fire(async () => { throw boom; })).rejects.toThrow(boom);
  });

  it("stays CLOSED after fewer failures than the threshold", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 2; i++) {
      await breaker.fire(fail).catch(() => {/* expected */});
    }
    expect(breaker.state).toBe("CLOSED");
  });

  // ── CLOSED → OPEN on threshold ─────────────────────────────────────────────

  it("opens after reaching the failure threshold", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {/* expected */});
    }
    expect(breaker.state).toBe("OPEN");
  });

  it("resets failure count on success (success before threshold)", async () => {
    const fail = async () => { throw new Error("fail"); };
    // 2 failures (threshold = 3)
    await breaker.fire(fail).catch(() => {});
    await breaker.fire(fail).catch(() => {});
    // 1 success resets the count
    await breaker.fire(async () => "ok");
    // 2 more failures should NOT open (count was reset)
    await breaker.fire(fail).catch(() => {});
    await breaker.fire(fail).catch(() => {});
    expect(breaker.state).toBe("CLOSED");
  });

  // ── OPEN → fast-fail ───────────────────────────────────────────────────────

  it("throws CircuitOpenError when OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }
    expect(breaker.state).toBe("OPEN");

    await expect(breaker.fire(async () => "probe")).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("CircuitOpenError carries the breaker name and OPEN state", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }

    try {
      await breaker.fire(async () => "x");
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      expect((e as CircuitOpenError).breakerName).toBe("test-breaker");
      expect((e as CircuitOpenError).state).toBe("OPEN");
    }
  });

  it("does not call the callable when OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }

    const spy = jest.fn(async () => "not called");
    await expect(breaker.fire(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
  });

  // ── OPEN → HALF_OPEN after timeout ─────────────────────────────────────────

  it("transitions to HALF_OPEN after the reset timeout", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }
    expect(breaker.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 60)); // wait > 50 ms resetTimeoutMs
    expect(breaker.state).toBe("HALF_OPEN");
  });

  // ── HALF_OPEN → CLOSED on probe success ────────────────────────────────────

  it("closes after a successful probe in HALF_OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.state).toBe("HALF_OPEN");

    const result = await breaker.fire(async () => "probe ok");
    expect(result).toBe("probe ok");
    expect(breaker.state).toBe("CLOSED");
  });

  // ── HALF_OPEN → OPEN on probe failure ──────────────────────────────────────

  it("reopens after a failed probe in HALF_OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.state).toBe("HALF_OPEN");

    await breaker.fire(async () => { throw new Error("probe failed"); }).catch(() => {});
    expect(breaker.state).toBe("OPEN");
  });

  it("rejects concurrent callers when probe is in flight (HALF_OPEN)", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 60));

    // Slow probe — keeps half-open probe slot occupied
    const slowProbe = breaker
      .fire(() => new Promise((r) => setTimeout(() => r("slow"), 200)))
      .catch(() => "err");

    // Concurrent request — should be fast-failed
    const concurrent = breaker.fire(async () => "concurrent");
    await expect(concurrent).rejects.toBeInstanceOf(CircuitOpenError);

    await slowProbe; // clean up
  });

  // ── Rolling window ─────────────────────────────────────────────────────────

  it("discards failures older than windowMs", async () => {
    // Use a very short window
    const shortWindowBreaker = new CircuitBreaker("short-window", {
      failureThreshold: 3,
      windowMs: 50, // 50 ms window
      resetTimeoutMs: 60_000,
    });

    const fail = async () => { throw new Error("fail"); };
    // 2 failures (below threshold of 3)
    await shortWindowBreaker.fire(fail).catch(() => {});
    await shortWindowBreaker.fire(fail).catch(() => {});

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 60));

    // 2 more failures after window — total in-window is still 2, should stay CLOSED
    await shortWindowBreaker.fire(fail).catch(() => {});
    await shortWindowBreaker.fire(fail).catch(() => {});
    expect(shortWindowBreaker.state).toBe("CLOSED");
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  it("reset() restores CLOSED state from OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };
    for (let i = 0; i < 3; i++) {
      await breaker.fire(fail).catch(() => {});
    }
    expect(breaker.state).toBe("OPEN");

    breaker.reset();
    expect(breaker.state).toBe("CLOSED");

    const result = await breaker.fire(async () => "after reset");
    expect(result).toBe("after reset");
  });
});

// ── Part 2: Route integration tests ──────────────────────────────────────────

describe("GET /api/markets/:id/comments — circuit breaker integration", () => {
  beforeEach(() => {
    commentsDbBreaker.reset();
    jest.clearAllMocks();
  });

  it("returns 200 with data when breaker is CLOSED and service succeeds", async () => {
    mockListMarketComments.mockResolvedValueOnce({
      data: [{ id: "c-1", body: "hello" }],
      nextCursor: null,
    });

    const res = await request(makeApp())
      .get("/api/markets/m-1/comments")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("returns 503 with service_unavailable code when db breaker is OPEN", async () => {
    // Trip the breaker by forcing 5 failures
    const fail = async () => { throw new Error("db down"); };
    for (let i = 0; i < 5; i++) {
      await commentsDbBreaker.fire(fail).catch(() => {});
    }
    expect(commentsDbBreaker.state).toBe("OPEN");

    const res = await request(makeApp())
      .get("/api/markets/m-1/comments")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("service_unavailable");
  });

  it("does not call listMarketComments when db breaker is OPEN", async () => {
    const fail = async () => { throw new Error("db down"); };
    for (let i = 0; i < 5; i++) {
      await commentsDbBreaker.fire(fail).catch(() => {});
    }

    await request(makeApp())
      .get("/api/markets/m-1/comments")
      .set("Origin", ALLOWED_ORIGIN);

    expect(mockListMarketComments).not.toHaveBeenCalled();
  });

  it("returns 200 again after breaker is reset (CLOSED)", async () => {
    // Trip breaker
    const fail = async () => { throw new Error("db down"); };
    for (let i = 0; i < 5; i++) {
      await commentsDbBreaker.fire(fail).catch(() => {});
    }

    // Manually reset for test (simulates recovery)
    commentsDbBreaker.reset();

    mockListMarketComments.mockResolvedValueOnce({ data: [], nextCursor: null });

    const res = await request(makeApp())
      .get("/api/markets/m-1/comments")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(200);
  });

  it("records DB service errors in the breaker failure count", async () => {
    mockListMarketComments.mockRejectedValue(new Error("connection refused"));

    // 4 failures — breaker should still be CLOSED (threshold = 5)
    for (let i = 0; i < 4; i++) {
      await request(makeApp())
        .get("/api/markets/m-1/comments")
        .set("Origin", ALLOWED_ORIGIN);
    }
    expect(commentsDbBreaker.state).toBe("CLOSED");

    // 5th failure — should trip
    await request(makeApp())
      .get("/api/markets/m-1/comments")
      .set("Origin", ALLOWED_ORIGIN);

    expect(commentsDbBreaker.state).toBe("OPEN");
  });
});

describe("POST /api/comments — outbound circuit breaker integration", () => {
  beforeEach(() => {
    commentsOutboundBreaker.reset();
    jest.clearAllMocks();
  });

  const validBody = {
    marketId: "m-1",
    body: "great prediction",
    outboundUrl: "https://hooks.example.com/notify",
  };

  it("returns 201 when outbound breaker is CLOSED and fetch succeeds", async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 });

    const res = await request(makeApp())
      .post("/api/comments")
      .send(validBody)
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(201);
    expect(res.body.data.marketId).toBe("m-1");
  });

  it("returns 503 when outbound breaker is OPEN", async () => {
    // Trip the outbound breaker
    const fail = async () => { throw new Error("http timeout"); };
    for (let i = 0; i < 5; i++) {
      await commentsOutboundBreaker.fire(fail).catch(() => {});
    }
    expect(commentsOutboundBreaker.state).toBe("OPEN");

    const res = await request(makeApp())
      .post("/api/comments")
      .send(validBody)
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("service_unavailable");
  });

  it("does not call fetchWithCorrelationId when outbound breaker is OPEN", async () => {
    const fail = async () => { throw new Error("http timeout"); };
    for (let i = 0; i < 5; i++) {
      await commentsOutboundBreaker.fire(fail).catch(() => {});
    }

    await request(makeApp())
      .post("/api/comments")
      .send(validBody)
      .set("Origin", ALLOWED_ORIGIN);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 201 with no outbound call when outboundUrl is absent", async () => {
    const res = await request(makeApp())
      .post("/api/comments")
      .send({ marketId: "m-2", body: "no outbound" })
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(201);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 201 and logs warning when outbound fetch throws (non-circuit-open error)", async () => {
    // Fetch throws a plain network error — breaker absorbs it, comment still created
    mockFetch.mockRejectedValueOnce(new Error("connection reset"));

    const res = await request(makeApp())
      .post("/api/comments")
      .send(validBody)
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(201);
  });

  it("records outbound fetch errors in the breaker failure count", async () => {
    mockFetch.mockRejectedValue(new Error("timeout"));

    // 4 failures — still CLOSED
    for (let i = 0; i < 4; i++) {
      await request(makeApp())
        .post("/api/comments")
        .send(validBody)
        .set("Origin", ALLOWED_ORIGIN);
    }
    expect(commentsOutboundBreaker.state).toBe("CLOSED");

    // 5th failure — trips the breaker
    await request(makeApp())
      .post("/api/comments")
      .send(validBody)
      .set("Origin", ALLOWED_ORIGIN);

    expect(commentsOutboundBreaker.state).toBe("OPEN");
  });

  it("returns 201 after outbound breaker is reset (CLOSED)", async () => {
    const fail = async () => { throw new Error("timeout"); };
    for (let i = 0; i < 5; i++) {
      await commentsOutboundBreaker.fire(fail).catch(() => {});
    }
    commentsOutboundBreaker.reset();

    mockFetch.mockResolvedValueOnce({ status: 200 });

    const res = await request(makeApp())
      .post("/api/comments")
      .send(validBody)
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(201);
  });
});

// ── Part 3: CircuitOpenError class ───────────────────────────────────────────

describe("CircuitOpenError", () => {
  it("is an instance of Error", () => {
    const err = new CircuitOpenError("my-breaker", "OPEN");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries the breaker name and state", () => {
    const err = new CircuitOpenError("my-breaker", "HALF_OPEN");
    expect(err.breakerName).toBe("my-breaker");
    expect(err.state).toBe("HALF_OPEN");
  });

  it("has a descriptive message", () => {
    const err = new CircuitOpenError("comments-db", "OPEN");
    expect(err.message).toContain("comments-db");
    expect(err.message).toContain("OPEN");
  });

  it("has the name CircuitOpenError", () => {
    const err = new CircuitOpenError("x", "OPEN");
    expect(err.name).toBe("CircuitOpenError");
  });
});
