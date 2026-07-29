/**
 * Unit tests for the indexer cursor endpoints.
 *
 *   POST   /api/indexer/cursor   — advance the cursor to a specific ledger
 *   DELETE /api/indexer/cursor   — reset the cursor to INDEXER_START_LEDGER
 *
 * All external I/O is mocked via injectable dependencies, so no database or
 * network access is required.
 *
 * Coverage areas:
 *   - Admin auth guard (403 without/with-wrong JWT)
 *   - Input validation (POST only)
 *   - Happy-path responses with correct before/after state in body
 *   - Audit log is called with actor, action, beforeState, afterState, ip
 *   - Audit log with x-forwarded-for IP extraction
 *   - Rate limiting (429 after limit exceeded)
 *   - Error propagation (getCursor / advanceCursor failures → 500)
 *   - Audit NOT called on failure
 */

// ── Environment stubs (must be set before any module import) ─────────────────
process.env.JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-000000";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";
process.env.ADMIN_ALLOWLIST = "GADMIN7777777777777777777777777777777777777777777777777777";
process.env.INDEXER_START_LEDGER = "1";

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { AuditEntryInput } from "../src/services/auditService";
import {
  createIndexerCursorRouter,
  type IndexerCursorRouterDeps,
  type IndexerCursorRouterOptions,
} from "../src/routes/indexer/cursor";
import { errorHandler } from "../src/middleware/errorHandler";

// ── JWT helpers ───────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";

const ADMIN_ADDR = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET!, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDR, role: "user" });

// ── App factory ───────────────────────────────────────────────────────────────

/**
 * Assemble a minimal Express app with the indexer cursor router mounted at
 * /api/indexer/cursor.  All I/O is replaced with stubs from `deps`.
 */
function makeApp(
  deps: IndexerCursorRouterDeps = {},
  opts: IndexerCursorRouterOptions = {},
): express.Express {
  const app = express();
  app.use(express.json());

  // Simulate pino-http request-id injection from src/index.ts.
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "indexer-cursor-req";
    next();
  });

  app.use("/api/indexer/cursor", createIndexerCursorRouter(opts, deps));
  app.use(errorHandler);
  return app;
}

// ── Default stub implementations ──────────────────────────────────────────────

function makeStubs(overrides: {
  currentCursor?: number;
  getCursorError?: Error;
  advanceCursorError?: Error;
} = {}) {
  const getCursor = jest.fn<Promise<number>, []>(async () => {
    if (overrides.getCursorError) throw overrides.getCursorError;
    return overrides.currentCursor ?? 100;
  });
  const advanceCursor = jest.fn<Promise<void>, [number]>(async () => {
    if (overrides.advanceCursorError) throw overrides.advanceCursorError;
  });
  const auditLogger = jest.fn<Promise<string>, [AuditEntryInput]>(
    async () => "test-correlation-id",
  );
  return { getCursor, advanceCursor, auditLogger };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard — both methods
// ─────────────────────────────────────────────────────────────────────────────

describe("auth guard", () => {
  const stubs = makeStubs();

  it("POST: returns 403 without Authorization header", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .send({ ledger: 200 });
    expect(res.status).toBe(403);
    expect(stubs.advanceCursor).not.toHaveBeenCalled();
  });

  it("POST: returns 403 for a non-admin JWT", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ ledger: 200 });
    expect(res.status).toBe(403);
    expect(stubs.advanceCursor).not.toHaveBeenCalled();
  });

  it("DELETE: returns 403 without Authorization header", async () => {
    const res = await request(makeApp(stubs)).delete("/api/indexer/cursor");
    expect(res.status).toBe(403);
    expect(stubs.advanceCursor).not.toHaveBeenCalled();
  });

  it("DELETE: returns 403 for a non-admin JWT", async () => {
    const res = await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(stubs.advanceCursor).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/indexer/cursor — input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/indexer/cursor — validation", () => {
  const stubs = makeStubs();

  it("rejects a missing ledger field", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(stubs.advanceCursor).not.toHaveBeenCalled();
  });

  it("rejects ledger = 0 (must be positive)", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects a negative ledger", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects a non-integer ledger", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 12.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects a string ledger", async () => {
    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/indexer/cursor — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/indexer/cursor — success", () => {
  it("advances cursor to the requested ledger and returns from/to", async () => {
    const stubs = makeStubs({ currentCursor: 150 });

    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 250 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ from: 150, to: 250 });
    expect(stubs.advanceCursor).toHaveBeenCalledWith(250);
  });

  it("reads before-state cursor before writing", async () => {
    const stubs = makeStubs({ currentCursor: 75 });

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });

    expect(stubs.getCursor).toHaveBeenCalledTimes(1);
    // getCursor must be called before advanceCursor
    const getCursorOrder = stubs.getCursor.mock.invocationCallOrder[0];
    const advanceCursorOrder = stubs.advanceCursor.mock.invocationCallOrder[0];
    expect(getCursorOrder).toBeLessThan(advanceCursorOrder!);
  });

  it("emits a correlationId in the response header", async () => {
    const stubs = makeStubs();

    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "trace-advance")
      .send({ ledger: 300 });

    expect(res.status).toBe(200);
    // The route sets x-correlation-id (CORRELATION_ID_HEADER), not x-request-id
    expect(res.headers["x-correlation-id"]).toBe("trace-advance");
  });

  it("writes an audit log with action=indexer.cursor.advance", async () => {
    const stubs = makeStubs({ currentCursor: 100 });

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });

    expect(stubs.auditLogger).toHaveBeenCalledTimes(1);
    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ action: "indexer.cursor.advance" }),
    );
  });

  it("audit log contains actor (walletAddress)", async () => {
    const stubs = makeStubs({ currentCursor: 100 });

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: ADMIN_ADDR }),
    );
  });

  it("audit log captures beforeState and afterState", async () => {
    const stubs = makeStubs({ currentCursor: 100 });

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeState: { cursor: 100 },
        afterState: { cursor: 200 },
      }),
    );
  });

  it("audit log captures the correlationId", async () => {
    const stubs = makeStubs({ currentCursor: 50 });

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "audit-advance")
      .send({ ledger: 150 });

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "audit-advance" }),
    );
  });

  it("audit log captures the client IP from x-forwarded-for", async () => {
    const stubs = makeStubs();

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Forwarded-For", "198.51.100.7")
      .send({ ledger: 300 });

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "198.51.100.7" }),
    );
  });

  it("audit log uses the first IP in a comma-separated x-forwarded-for list", async () => {
    const stubs = makeStubs();

    await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Forwarded-For", "192.0.2.1, 10.0.0.2, 172.16.0.3")
      .send({ ledger: 300 });

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "192.0.2.1" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/indexer/cursor — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/indexer/cursor — success", () => {
  it("resets cursor to INDEXER_START_LEDGER and returns from/to", async () => {
    const stubs = makeStubs({ currentCursor: 500 });
    const startLedger = parseInt(process.env.INDEXER_START_LEDGER!, 10); // = 1

    const res = await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ from: 500, to: startLedger });
    expect(stubs.advanceCursor).toHaveBeenCalledWith(startLedger);
  });

  it("emits a correlationId in the response header", async () => {
    const stubs = makeStubs();

    const res = await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "trace-reset");

    expect(res.status).toBe(200);
    // The route sets x-correlation-id (CORRELATION_ID_HEADER), not x-request-id
    expect(res.headers["x-correlation-id"]).toBe("trace-reset");
  });

  it("writes an audit log with action=indexer.cursor.reset", async () => {
    const stubs = makeStubs({ currentCursor: 500 });

    await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(stubs.auditLogger).toHaveBeenCalledTimes(1);
    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ action: "indexer.cursor.reset" }),
    );
  });

  it("audit log contains actor (walletAddress)", async () => {
    const stubs = makeStubs({ currentCursor: 500 });

    await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: ADMIN_ADDR }),
    );
  });

  it("audit log captures beforeState and afterState for reset", async () => {
    const stubs = makeStubs({ currentCursor: 500 });
    const startLedger = parseInt(process.env.INDEXER_START_LEDGER!, 10);

    await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeState: { cursor: 500 },
        afterState: { cursor: startLedger },
      }),
    );
  });

  it("audit log captures the correlationId", async () => {
    const stubs = makeStubs({ currentCursor: 500 });

    await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "audit-reset");

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "audit-reset" }),
    );
  });

  it("audit log captures client IP from x-forwarded-for", async () => {
    const stubs = makeStubs();

    await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Forwarded-For", "203.0.113.99");

    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.99" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("POST: returns 429 after the configured limit is exceeded", async () => {
    const stubs = makeStubs();
    const app = makeApp(stubs, { rateLimitPerMinute: 1 });

    const first = await request(app)
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 100 });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });

  it("DELETE: returns 429 after the configured limit is exceeded", async () => {
    const stubs = makeStubs();
    const app = makeApp(stubs, { rateLimitPerMinute: 1 });

    const first = await request(app)
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(first.status).toBe(200);

    const second = await request(app)
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(second.status).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("error propagation", () => {
  it("POST: forwards getCursor() failures to the error handler (500)", async () => {
    const stubs = makeStubs({ getCursorError: new Error("db read failure") });

    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });

    expect(res.status).toBe(500);
    // Audit must NOT be written on failure
    expect(stubs.auditLogger).not.toHaveBeenCalled();
  });

  it("POST: forwards advanceCursor() failures to the error handler (500)", async () => {
    const stubs = makeStubs({ advanceCursorError: new Error("db write failure") });

    const res = await request(makeApp(stubs))
      .post("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ ledger: 200 });

    expect(res.status).toBe(500);
    expect(stubs.auditLogger).not.toHaveBeenCalled();
  });

  it("DELETE: forwards getCursor() failures to the error handler (500)", async () => {
    const stubs = makeStubs({ getCursorError: new Error("db read failure") });

    const res = await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
    expect(stubs.auditLogger).not.toHaveBeenCalled();
  });

  it("DELETE: forwards advanceCursor() failures to the error handler (500)", async () => {
    const stubs = makeStubs({ advanceCursorError: new Error("db write failure") });

    const res = await request(makeApp(stubs))
      .delete("/api/indexer/cursor")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
    expect(stubs.auditLogger).not.toHaveBeenCalled();
  });
});
