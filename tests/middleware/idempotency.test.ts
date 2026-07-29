/**
 * Focused tests for src/middleware/idempotency.ts
 *
 * Covers:
 *  ✓ isValidIdempotencyKey        — validation helper
 *  ✓ sha256                       — deterministic hash helper
 *  ✓ idempotency middleware        — no key, invalid key, miss, hit (replay), conflict, non-2xx
 *  ✓ checkExportsIdempotency       — no key, invalid key, miss, hit (replay), conflict
 *  ✓ persistExportsIdempotency     — successful persist, DB error logged and swallowed
 *
 * The DB layer is fully mocked so these tests run without Postgres.
 */

// ─── 1. DB mock (must be established BEFORE importing the module under test) ─

const mockInsertValues = jest.fn().mockResolvedValue(undefined);
const mockInsertCall = jest.fn(() => ({ values: mockInsertValues }));
const mockSelectLimit = jest.fn();

const makeSelectChain = () => ({
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: mockSelectLimit,
});

const mockDb = {
  select: jest.fn(() => makeSelectChain()),
  insert: mockInsertCall,
};

jest.mock("../../src/db", () => ({ db: mockDb }));
jest.mock("../../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock("../../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "test-req-id"),
}));

// ─── 2. Imports (after mocks) ────────────────────────────────────────────────

import request from "supertest";
import express, { type Request, type Response } from "express";
import crypto from "crypto";

import {
  idempotency,
  checkExportsIdempotency,
  persistExportsIdempotency,
  isValidIdempotencyKey,
  sha256,
  IDEMPOTENCY_TTL_MS,
} from "../../src/middleware/idempotency";

// ─── 3. Helpers ──────────────────────────────────────────────────────────────

function makeApp(handler: (req: Request, res: Response) => void) {
  const app = express();
  app.use(express.json());
  app.post("/test", idempotency, handler);
  app.patch("/test", idempotency, handler);
  return app;
}

const KEY = "test-idempotency-key-abc-123";
const BODY = { amount: "100" };
const BODY_FP = sha256(JSON.stringify(BODY));

const makeStoredRecord = (override: Partial<{ fingerprint: string; responseStatus: number }> = {}) => ({
  key: KEY,
  fingerprint: BODY_FP,
  responseStatus: 201,
  responseBody: { data: { id: "abc" } },
  responseHeaders: { "content-type": "application/json" },
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
  ...override,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.select.mockImplementation(() => makeSelectChain());
  mockInsertCall.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockResolvedValue(undefined);
});

// ─── 4. isValidIdempotencyKey ────────────────────────────────────────────────

describe("isValidIdempotencyKey", () => {
  it("accepts a normal UUID-like key", () => {
    expect(isValidIdempotencyKey("abc-123-XYZ")).toBe(true);
  });

  it("accepts a key of exactly 255 characters", () => {
    expect(isValidIdempotencyKey("a".repeat(255))).toBe(true);
  });

  it("rejects a key of 256 characters", () => {
    expect(isValidIdempotencyKey("a".repeat(256))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
  });

  it("rejects a key containing non-printable characters", () => {
    expect(isValidIdempotencyKey("key\x00value")).toBe(false);
  });

  it("rejects a key containing non-ASCII characters", () => {
    expect(isValidIdempotencyKey("key-字符")).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(isValidIdempotencyKey(123)).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
  });

  it("accepts all printable ASCII edge cases (space, tilde)", () => {
    expect(isValidIdempotencyKey(" ")).toBe(true);   // \x20
    expect(isValidIdempotencyKey("~")).toBe(true);   // \x7E
  });
});

// ─── 5. sha256 ───────────────────────────────────────────────────────────────

describe("sha256", () => {
  it("returns a deterministic 64-char hex string", () => {
    const result = sha256("hello");
    expect(result).toBe(crypto.createHash("sha256").update("hello").digest("hex"));
    expect(result).toHaveLength(64);
  });

  it("produces different digests for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

// ─── 6. IDEMPOTENCY_TTL_MS ───────────────────────────────────────────────────

describe("IDEMPOTENCY_TTL_MS", () => {
  it("is 24 hours in milliseconds", () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ─── 7. idempotency middleware (standard JSON routes) ────────────────────────

describe("idempotency middleware", () => {
  // ── No key ──────────────────────────────────────────────────────────────────

  describe("no Idempotency-Key header", () => {
    it("passes through to the handler without querying the DB", async () => {
      const handler = jest.fn((_req: Request, res: Response) =>
        res.status(201).json({ ok: true }),
      );

      const res = await request(makeApp(handler))
        .post("/test")
        .send(BODY);

      expect(res.status).toBe(201);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  // ── Invalid key ──────────────────────────────────────────────────────────────

  describe("invalid Idempotency-Key", () => {
    it("returns 400 for a key longer than 255 characters", async () => {
      const res = await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", "x".repeat(256))
        .send(BODY);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_idempotency_key");
    });

    it("returns 400 for a key with non-printable ASCII characters", async () => {
      const res = await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", "key\x01bad")
        .send(BODY);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_idempotency_key");
    });

    it("includes a correlationId in the 400 error response", async () => {
      const res = await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", "a".repeat(256))
        .send(BODY);

      expect(res.body.error.correlationId).toBeDefined();
    });

    it("does not call the route handler on invalid key", async () => {
      const handler = jest.fn();
      await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", "a".repeat(256))
        .send(BODY);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Cache miss (first call) ──────────────────────────────────────────────────

  describe("cache miss (first call)", () => {
    it("calls the handler and persists a 2xx response", async () => {
      mockSelectLimit.mockResolvedValue([]); // miss

      const handler = (_req: Request, res: Response) =>
        res.status(201).json({ data: { id: "abc" } });

      const res = await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(res.status).toBe(201);
      expect(res.headers["idempotent-replayed"]).toBeUndefined();

      // Verify persistence was attempted
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockInsertCall).toHaveBeenCalledTimes(1);
      const insertedValues = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(insertedValues.key).toBe(KEY);
      expect(insertedValues.fingerprint).toBe(BODY_FP);
      expect(insertedValues.responseStatus).toBe(201);
      expect(insertedValues.responseBody).toEqual({ data: { id: "abc" } });
    });

    it("does NOT persist a 4xx response", async () => {
      mockSelectLimit.mockResolvedValue([]);

      const handler = (_req: Request, res: Response) =>
        res.status(422).json({ error: { code: "validation_error" } });

      const res = await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(res.status).toBe(422);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockInsertCall).not.toHaveBeenCalled();
    });

    it("does NOT persist a 5xx response", async () => {
      mockSelectLimit.mockResolvedValue([]);

      const handler = (_req: Request, res: Response) =>
        res.status(500).json({ error: { code: "internal_error" } });

      const res = await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(res.status).toBe(500);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockInsertCall).not.toHaveBeenCalled();
    });

    it("persists headers included in the replay-headers allow-list", async () => {
      mockSelectLimit.mockResolvedValue([]);

      const handler = (_req: Request, res: Response) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-request-id", "req-123");
        res.setHeader("x-secret-internal", "should-not-persist");
        res.status(200).json({ ok: true });
      };

      await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      await new Promise<void>((resolve) => setImmediate(resolve));

      const headers = mockInsertValues.mock.calls[0][0].responseHeaders as Record<string, string>;
      expect(headers["content-type"]).toBeDefined();
      expect(headers["x-request-id"]).toBeDefined();
      expect(headers["x-secret-internal"]).toBeUndefined();
    });
  });

  // ── Cache hit — same fingerprint (replay) ───────────────────────────────────

  describe("cache hit — same fingerprint (replay)", () => {
    it("returns stored response and sets Idempotent-Replayed: true", async () => {
      mockSelectLimit.mockResolvedValue([makeStoredRecord()]);

      const handler = jest.fn();
      const res = await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ data: { id: "abc" } });
      expect(res.headers["idempotent-replayed"]).toBe("true");
    });

    it("does NOT call the route handler on replay", async () => {
      mockSelectLimit.mockResolvedValue([makeStoredRecord()]);

      const handler = jest.fn();
      await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(handler).not.toHaveBeenCalled();
    });

    it("does NOT attempt to persist on replay", async () => {
      mockSelectLimit.mockResolvedValue([makeStoredRecord()]);

      await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(mockInsertCall).not.toHaveBeenCalled();
    });

    it("replays stored content-type header", async () => {
      mockSelectLimit.mockResolvedValue([makeStoredRecord()]);

      const res = await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(res.headers["content-type"]).toContain("application/json");
    });

    it("works on PATCH requests", async () => {
      mockSelectLimit.mockResolvedValue([makeStoredRecord()]);

      const res = await request(makeApp(jest.fn()))
        .patch("/test")
        .set("Idempotency-Key", KEY)
        .send(BODY);

      expect(res.status).toBe(201);
      expect(res.headers["idempotent-replayed"]).toBe("true");
    });
  });

  // ── Cache hit — different fingerprint (conflict) ────────────────────────────

  describe("cache hit — different fingerprint (conflict)", () => {
    it("returns 409 conflict", async () => {
      mockSelectLimit.mockResolvedValue([
        makeStoredRecord({ fingerprint: "totally-different-hash" }),
      ]);

      const res = await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send({ amount: "999" }); // different body

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("conflict");
    });

    it("does NOT call the route handler on conflict", async () => {
      mockSelectLimit.mockResolvedValue([
        makeStoredRecord({ fingerprint: "different" }),
      ]);

      const handler = jest.fn();
      await request(makeApp(handler))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send({ amount: "999" });

      expect(handler).not.toHaveBeenCalled();
    });

    it("includes a correlationId in the 409 response", async () => {
      mockSelectLimit.mockResolvedValue([
        makeStoredRecord({ fingerprint: "different" }),
      ]);

      const res = await request(makeApp(jest.fn()))
        .post("/test")
        .set("Idempotency-Key", KEY)
        .send({ different: true });

      expect(res.body.error.correlationId).toBeDefined();
    });
  });
});

// ─── 8. checkExportsIdempotency ──────────────────────────────────────────────

describe("checkExportsIdempotency", () => {
  function makeReqRes(idempotencyKey?: string) {
    const app = express();
    app.use(express.json());
    let capturedResult: Awaited<ReturnType<typeof checkExportsIdempotency>> | null = null;
    let capturedError: unknown = null;

    app.get("/export", async (req, res, next) => {
      try {
        capturedResult = await checkExportsIdempotency(req, res, "fp-source", "req-id-123");
        if (!capturedResult.hit) {
          res.status(200).json({ captured: capturedResult });
        }
      } catch (err) {
        capturedError = err;
        next(err);
      }
    });

    return { app, idempotencyKey, getCaptured: () => ({ result: capturedResult, error: capturedError }) };
  }

  it("returns { hit: false, key: null } when no Idempotency-Key header", async () => {
    const { app, getCaptured } = makeReqRes();
    mockSelectLimit.mockResolvedValue([]);

    const res = await request(app).get("/export");

    expect(res.status).toBe(200);
    const { result } = getCaptured();
    expect(result).toMatchObject({ hit: false, key: null, fingerprint: null });
  });

  it("returns { hit: false, key, fingerprint } on cache miss", async () => {
    const app = express();
    app.use(express.json());
    let result: Awaited<ReturnType<typeof checkExportsIdempotency>> | null = null;

    app.get("/export", async (req, res, next) => {
      try {
        result = await checkExportsIdempotency(req, res, "fp-source", "req-id-123");
        if (!result.hit) {
          res.status(200).json({ ok: true });
        }
      } catch (err) {
        next(err);
      }
    });
    mockSelectLimit.mockResolvedValue([]);

    await request(app).get("/export").set("Idempotency-Key", KEY);

    expect(result).toMatchObject({ hit: false, key: KEY });
    expect((result as { fingerprint: string }).fingerprint).toBe(sha256("fp-source"));
  });

  it("writes replay response and returns { hit: true } on cache hit", async () => {
    const fpSource = "fp-source";
    const fp = sha256(fpSource);
    const stored = {
      key: KEY,
      fingerprint: fp,
      responseStatus: 200,
      responseBody: { content: '["row1"]' },
      responseHeaders: { "content-type": "text/csv" },
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    mockSelectLimit.mockResolvedValue([stored]);

    const app = express();
    app.use(express.json());
    let hitResult: boolean | null = null;

    app.get("/export", async (req, res, next) => {
      try {
        const r = await checkExportsIdempotency(req, res, fpSource, "req-id-123");
        hitResult = r.hit === true;
        if (r.hit !== true) {
          res.status(200).json({ ok: true });
        }
      } catch (err) {
        next(err);
      }
    });

    const res = await request(app).get("/export").set("Idempotency-Key", KEY);

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(hitResult).toBe(true);
  });

  it("throws RouteError on invalid key format", async () => {
    const app = express();
    app.use(express.json());
    let caughtError: unknown = null;

    app.get("/export", async (req, res, next) => {
      try {
        await checkExportsIdempotency(req, res, "fp-source", "req-id-123");
        res.status(200).json({ ok: true });
      } catch (err) {
        caughtError = err;
        next(err);
      }
    });
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: { code: "bad_request" } });
    });

    await request(app)
      .get("/export")
      .set("Idempotency-Key", "a".repeat(256));

    expect(caughtError).toBeDefined();
    // Should have the BadRequest kind from RouteErrorFactory
    expect((caughtError as { kind: string }).kind).toBe("BadRequest");
  });

  it("throws RouteError on fingerprint conflict", async () => {
    mockSelectLimit.mockResolvedValue([{
      key: KEY,
      fingerprint: "completely-different-hash",
      responseStatus: 200,
      responseBody: { content: "old" },
      responseHeaders: {},
      expiresAt: new Date(Date.now() + 86_400_000),
    }]);

    const app = express();
    app.use(express.json());
    let caughtError: unknown = null;

    app.get("/export", async (req, res, next) => {
      try {
        await checkExportsIdempotency(req, res, "new-fp-source", "req-id-123");
        res.status(200).json({ ok: true });
      } catch (err) {
        caughtError = err;
        next(err);
      }
    });
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(409).json({ error: { code: "conflict" } });
    });

    const res = await request(app).get("/export").set("Idempotency-Key", KEY);

    expect(res.status).toBe(409);
    expect((caughtError as { kind: string }).kind).toBe("Conflict");
  });
});

// ─── 9. persistExportsIdempotency ────────────────────────────────────────────

describe("persistExportsIdempotency", () => {
  it("inserts a record with the provided values", async () => {
    mockInsertValues.mockResolvedValue(undefined);

    await persistExportsIdempotency(
      KEY,
      "fp-hash-abc",
      "buffer content",
      200,
      { "content-type": "text/csv" },
      "req-id-123",
    );

    expect(mockInsertCall).toHaveBeenCalledTimes(1);
    const inserted = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.key).toBe(KEY);
    expect(inserted.fingerprint).toBe("fp-hash-abc");
    expect((inserted.responseBody as { content: string }).content).toBe("buffer content");
    expect(inserted.responseStatus).toBe(200);
    expect((inserted.responseHeaders as Record<string, string>)["content-type"]).toBe("text/csv");
    expect(inserted.expiresAt).toBeInstanceOf(Date);
  });

  it("sets expiresAt approximately 24 hours in the future", async () => {
    mockInsertValues.mockResolvedValue(undefined);
    const before = Date.now();

    await persistExportsIdempotency(KEY, "fp", "buf", 200, {}, "req-id");

    const after = Date.now();
    const inserted = mockInsertValues.mock.calls[0][0] as { expiresAt: Date };
    const expiresMs = inserted.expiresAt.getTime();

    expect(expiresMs).toBeGreaterThanOrEqual(before + IDEMPOTENCY_TTL_MS);
    expect(expiresMs).toBeLessThanOrEqual(after + IDEMPOTENCY_TTL_MS + 100);
  });

  it("swallows DB errors (logs and does not throw)", async () => {
    const dbErr = new Error("DB unavailable");
    mockInsertValues.mockRejectedValue(dbErr);

    // Should not throw
    await expect(
      persistExportsIdempotency(KEY, "fp", "buf", 200, {}, "req-id"),
    ).resolves.toBeUndefined();
  });
});
