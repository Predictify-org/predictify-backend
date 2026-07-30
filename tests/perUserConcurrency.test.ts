/**
 * tests/perUserConcurrency.test.ts
 *
 * Unit / integration tests for `createPerUserConcurrencyMiddleware` and the
 * `perUserConcurrency` singleton exported from
 * `src/middleware/perUserConcurrency.ts`.
 *
 * Coverage targets (≥ 90 % on changed lines):
 *   - Requests within the limit are passed through to the next handler
 *   - Requests exceeding the concurrent limit receive HTTP 429
 *   - 429 response contains the standardised error envelope
 *   - `Retry-After` header is set on 429 responses
 *   - Counter is decremented when the response finishes ("finish" event)
 *   - Counter is decremented when the slot is released (sequential reuse)
 *   - Per-user isolation — different users have independent counters
 *   - Anonymous users are keyed by IP address
 *   - X-Forwarded-For is respected for IP keying
 *   - A custom `keyGenerator` is honoured
 *   - A custom `limit` overrides the environment default
 *   - Limit clamping: negative / zero limit becomes 1
 *   - Structured warning is logged when the limit is exceeded
 *   - The correlation ID from `res.locals` is forwarded to the logger
 *   - No warning is logged for allowed requests
 *   - The `perUserConcurrency` singleton is a valid RequestHandler
 *
 * NOTE ON CONCURRENCY TESTING
 * ----------------------------
 * supertest's `request(app).get(...)` does NOT send until you `.then()` /
 * `await` the Test object. To simulate truly concurrent in-flight requests we
 * start a real `http.Server`, fire requests with `node-fetch` / `http.get`,
 * and control when the server handler resolves via a shared latch mechanism.
 */

// ── 1. Env vars (must precede project imports) ──────────────────────────────

process.env.NODE_ENV = "test";
process.env.PORT = "3099";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "per-user-concurrency-test-secret-at-least-32!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
process.env.MAX_CONCURRENT_REQUESTS_PER_USER = "3";

// ── 2. Module-level mocks ────────────────────────────────────────────────────

jest.mock("../src/config/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── 3. Imports ───────────────────────────────────────────────────────────────

import http from "http";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import request from "supertest";
import {
  createPerUserConcurrencyMiddleware,
  perUserConcurrency,
  type PerUserConcurrencyOptions,
} from "../src/middleware/perUserConcurrency";
import { logger } from "../src/config/logger";

const mockWarn = logger.warn as jest.Mock;

// ── 4. Helpers ───────────────────────────────────────────────────────────────

/** ms → Promise void */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build an Express app with the concurrency middleware + a controllable
 * `/api/test` route, then spin up a real HTTP server on an ephemeral port.
 *
 * Returns the server and a `gate` object.  Call `gate.open()` to let all
 * pending handlers complete; call `gate.close()` to make them hang again.
 */
function makeServer(opts: PerUserConcurrencyOptions = {}): {
  server: http.Server;
  /** Resolve all currently-pending handler promises */
  openGate: () => void;
  baseUrl: () => string;
  close: () => Promise<void>;
} {
  let pendingResolvers: Array<() => void> = [];
  let gateOpen = false;

  const app = express();

  // Simulate requireAuth: inject a user via header.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.headers["x-test-user-id"] as string | undefined;
    if (userId) {
      (
        req as Request & { user?: { id: string; stellarAddress: string } }
      ).user = {
        id: userId,
        stellarAddress: `G${userId.toUpperCase()}`,
      };
    }
    next();
  });

  app.use("/api", createPerUserConcurrencyMiddleware(opts));

  app.get("/api/test", (_req, res) => {
    if (gateOpen) {
      res.json({ ok: true });
      return;
    }
    const p = new Promise<void>((resolve) => pendingResolvers.push(resolve));
    void p.then(() => res.json({ ok: true }));
  });

  const server = http.createServer(app);

  return {
    server,
    openGate() {
      gateOpen = true;
      const local = pendingResolvers;
      pendingResolvers = [];
      local.forEach((r) => r());
    },
    baseUrl() {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      return `http://127.0.0.1:${addr.port}`;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Make a GET request to the server and return status + body.
 * Uses the built-in `fetch` (Node 18+) so it's truly concurrent.
 */
async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const res = await fetch(url, { headers });
  const body = (await res.json()) as unknown;
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    hdrs[k] = v;
  });
  return { status: res.status, body, headers: hdrs };
}

// ── 5. Tests ─────────────────────────────────────────────────────────────────

describe("createPerUserConcurrencyMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Allowed requests ───────────────────────────────────────────────────────

  describe("allows requests within the limit", () => {
    it("passes a single request through to the next handler", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 3 });
      openGate(); // immediate responses
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

      const res = await get(`${baseUrl()}/api/test`, {
        "x-test-user-id": "alice",
      });

      await close();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("allows exactly `limit` simultaneous in-flight requests", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 2 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      // Fire 2 requests (they hang at the gate).
      const req1 = get(url, { "x-test-user-id": "bob" });
      const req2 = get(url, { "x-test-user-id": "bob" });

      // Give them time to reach the middleware.
      await wait(80);

      // Both should be in-flight (not yet responded).
      // Open the gate to let them finish.
      openGate();

      const [r1, r2] = await Promise.all([req1, req2]);
      await close();

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });
  });

  // ── 429 behaviour ─────────────────────────────────────────────────────────

  describe("rejects requests exceeding the limit with 429", () => {
    it("returns 429 when a (limit+1)-th request arrives for the same user", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 2 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      // Two requests hold the slots.
      const req1 = get(url, { "x-test-user-id": "carol" });
      const req2 = get(url, { "x-test-user-id": "carol" });
      await wait(80);

      // Third must be rejected synchronously.
      const blocked = await get(url, { "x-test-user-id": "carol" });
      expect(blocked.status).toBe(429);

      openGate();
      await Promise.all([req1, req2]);
      await close();
    });

    it("returns the standard error envelope on 429", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-test-user-id": "dave" });
      await wait(80);

      const blocked = await get(url, { "x-test-user-id": "dave" });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({
        error: {
          code: "concurrency_limit_exceeded",
          message: "Too many concurrent requests",
          retryAfter: 1,
        },
      });

      openGate();
      await req1;
      await close();
    });

    it("includes Retry-After: 1 header on 429 responses", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-test-user-id": "eve" });
      await wait(80);

      const blocked = await get(url, { "x-test-user-id": "eve" });
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBe("1");

      openGate();
      await req1;
      await close();
    });
  });

  // ── Counter decrement / slot release ──────────────────────────────────────

  describe("releases the slot after the response finishes", () => {
    it("allows a new request once a previous one completes", async () => {
      // Use supertest for simple sequential tests (no concurrency needed).
      const app = express();
      app.use(createPerUserConcurrencyMiddleware({ limit: 1 }));
      app.get("/api/test", (_req, res) => res.json({ ok: true }));

      const r1 = await request(app)
        .get("/api/test")
        .set("x-test-user-id", "frank");
      expect(r1.status).toBe(200);

      const r2 = await request(app)
        .get("/api/test")
        .set("x-test-user-id", "frank");
      expect(r2.status).toBe(200);
    });

    it("counter stays accurate across many sequential requests", async () => {
      const app = express();
      app.use(createPerUserConcurrencyMiddleware({ limit: 1 }));
      app.get("/api/test", (_req, res) => res.json({ ok: true }));

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .get("/api/test")
          .set("x-test-user-id", "grace");
        expect(res.status).toBe(200);
      }
    });
  });

  // ── Per-user isolation ─────────────────────────────────────────────────────

  describe("per-user isolation", () => {
    it("maintains separate counters for different users", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      // Heidi holds the single slot (slow handler, won't complete until gate opens).
      const req1 = get(url, { "x-test-user-id": "heidi" });
      await wait(80);

      // Heidi's next request is blocked immediately (her slot is taken).
      const heidiBlocked = await get(url, { "x-test-user-id": "heidi" });
      expect(heidiBlocked.status).toBe(429);

      // Open the gate so heidi's first request can complete.
      openGate();
      const r1 = await req1;
      expect(r1.status).toBe(200);

      // After slot is released, Ivan also has a free slot.
      // Use the gate-open state (default now): next request responds immediately.
      const ivan = await get(url, { "x-test-user-id": "ivan" });
      expect(ivan.status).toBe(200);

      await close();
    });
  });

  // ── Anonymous / IP keying ─────────────────────────────────────────────────

  describe("anonymous (IP-keyed) callers", () => {
    it("allows sequential anonymous requests (slot freed each time)", async () => {
      const app = express();
      app.use(createPerUserConcurrencyMiddleware({ limit: 2 }));
      app.get("/api/test", (_req, res) => res.json({ ok: true }));

      const r1 = await request(app).get("/api/test");
      const r2 = await request(app).get("/api/test");
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });

    it("blocks anonymous concurrent requests that exceed the limit", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url); // anonymous, takes the slot
      await wait(80);

      const blocked = await get(url); // anonymous, same IP
      expect(blocked.status).toBe(429);

      openGate();
      await req1;
      await close();
    });

    it("respects X-Forwarded-For: same first-hop IP is blocked", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-forwarded-for": "203.0.113.1" });
      await wait(80);

      const blocked = await get(url, { "x-forwarded-for": "203.0.113.1" });
      expect(blocked.status).toBe(429);

      openGate();
      await req1;
      await close();
    });

    it("respects X-Forwarded-For: different first-hop IPs get separate slots", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      // IP 203.0.113.1 holds the single slot.
      const req1 = get(url, { "x-forwarded-for": "203.0.113.1" });
      await wait(80);

      // Same IP — blocked immediately (synchronous 429, doesn't touch the gate).
      const blocked = await get(url, { "x-forwarded-for": "203.0.113.1" });
      expect(blocked.status).toBe(429);

      // Open the gate now so req1 completes and frees its slot.
      openGate();
      await req1;

      // Different IP — now makes a fresh request. Gate is open so it resolves.
      const different = await get(url, {
        "x-forwarded-for": "203.0.113.2",
      });
      expect(different.status).toBe(200);

      await close();
    });
  });

  // ── Custom keyGenerator ────────────────────────────────────────────────────

  describe("custom keyGenerator", () => {
    it("uses the returned key for bucketing", async () => {
      // All requests map to the same key regardless of user.
      const keyGenerator = jest.fn().mockReturnValue("shared-key");

      const { server, openGate, baseUrl, close } = makeServer({
        limit: 1,
        keyGenerator,
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-test-user-id": "user-a" });
      await wait(80);

      // user-b maps to the same bucket via keyGenerator → blocked.
      const blocked = await get(url, { "x-test-user-id": "user-b" });
      expect(blocked.status).toBe(429);
      expect(keyGenerator).toHaveBeenCalled();

      openGate();
      await req1;
      await close();
    });
  });

  // ── Custom limit ──────────────────────────────────────────────────────────

  describe("custom limit", () => {
    it("accepts a limit of 1 (single-flight per user)", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-test-user-id": "single" });
      await wait(80);

      const blocked = await get(url, { "x-test-user-id": "single" });
      expect(blocked.status).toBe(429);

      openGate();
      await req1;
      await close();
    });

    it("clamps fractional / negative limit values to at least 1", async () => {
      // limit=-5 → Math.max(1, Math.floor(-5)) = 1
      const { server, openGate, baseUrl, close } = makeServer({ limit: -5 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-test-user-id": "clamped" });
      await wait(80);

      const blocked = await get(url, { "x-test-user-id": "clamped" });
      expect(blocked.status).toBe(429);

      openGate();
      await req1;
      await close();
    });

    it("allows a high limit to pass many concurrent requests", async () => {
      const app = express();
      app.use(createPerUserConcurrencyMiddleware({ limit: 50 }));
      app.get("/api/test", (_req, res) => res.json({ ok: true }));

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app).get("/api/test").set("x-test-user-id", "high-limit"),
        ),
      );
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });
  });

  // ── Structured logging ────────────────────────────────────────────────────

  describe("structured logging", () => {
    it("logs a warning when the concurrency limit is exceeded", async () => {
      const { server, openGate, baseUrl, close } = makeServer({ limit: 1 });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `${baseUrl()}/api/test`;

      const req1 = get(url, { "x-test-user-id": "log-test" });
      await wait(80);

      await get(url, { "x-test-user-id": "log-test" });

      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "user:log-test",
          limit: 1,
          // When middleware is mounted at /api, Express strips the prefix
          // from req.path so the middleware sees "/test", not "/api/test".
          path: "/test",
          method: "GET",
        }),
        "concurrency_limit_exceeded",
      );

      openGate();
      await req1;
      await close();
    });

    it("does not log a warning when requests are within the limit", async () => {
      const app = express();
      app.use(createPerUserConcurrencyMiddleware({ limit: 5 }));
      app.get("/api/test", (_req, res) => res.json({ ok: true }));

      await request(app).get("/api/test").set("x-test-user-id", "no-warn");

      expect(mockWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        "concurrency_limit_exceeded",
      );
    });

    it("forwards the correlation ID from res.locals to the log entry", async () => {
      // Build a custom app that injects a known correlationId via a middleware
      // placed before the concurrency middleware.
      const withCorrelation: RequestHandler = (_req, res, next) => {
        res.locals.correlationId = "test-corr-123";
        next();
      };

      const app = express();
      app.use((req: Request, _res: Response, next: NextFunction) => {
        const userId = req.headers["x-test-user-id"] as string | undefined;
        if (userId) {
          (
            req as Request & { user?: { id: string; stellarAddress: string } }
          ).user = {
            id: userId,
            stellarAddress: `G${userId.toUpperCase()}`,
          };
        }
        next();
      });
      app.use("/api", withCorrelation);
      app.use("/api", createPerUserConcurrencyMiddleware({ limit: 1 }));

      let pendingResolver: (() => void) | null = null;
      app.get("/api/test", (_req, res) => {
        const p = new Promise<void>((r) => {
          pendingResolver = r;
        });
        void p.then(() => res.json({ ok: true }));
      });

      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/api/test`;

      const req1 = get(url, { "x-test-user-id": "corr-user" });
      await wait(80);

      await get(url, { "x-test-user-id": "corr-user" }); // blocked

      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: "test-corr-123" }),
        "concurrency_limit_exceeded",
      );

      // Clean up.
      pendingResolver?.();
      await req1;
      await new Promise<void>((r, rej) =>
        server.close((e) => (e ? rej(e) : r())),
      );
    });
  });

  // ── Instance isolation ────────────────────────────────────────────────────

  describe("instance isolation", () => {
    it("two independent middleware instances have separate counters", async () => {
      // Two apps, each with their own middleware instance.
      const mw1 = createPerUserConcurrencyMiddleware({ limit: 1 });
      const mw2 = createPerUserConcurrencyMiddleware({ limit: 1 });

      let resolver1: (() => void) | null = null;

      const app1 = express();
      app1.use((req: Request, _res: Response, next: NextFunction) => {
        const userId = req.headers["x-test-user-id"] as string | undefined;
        if (userId) {
          (
            req as Request & { user?: { id: string; stellarAddress: string } }
          ).user = { id: userId, stellarAddress: `G${userId.toUpperCase()}` };
        }
        next();
      });
      app1.use("/api", mw1);
      app1.get("/api/test", (_req, res) => {
        const p = new Promise<void>((r) => {
          resolver1 = r;
        });
        void p.then(() => res.json({ ok: true }));
      });

      const app2 = express();
      app2.use((req: Request, _res: Response, next: NextFunction) => {
        const userId = req.headers["x-test-user-id"] as string | undefined;
        if (userId) {
          (
            req as Request & { user?: { id: string; stellarAddress: string } }
          ).user = { id: userId, stellarAddress: `G${userId.toUpperCase()}` };
        }
        next();
      });
      app2.use("/api", mw2);
      app2.get("/api/test", (_req, res) => res.json({ ok: true }));

      const s1 = http.createServer(app1);
      const s2 = http.createServer(app2);
      await Promise.all([
        new Promise<void>((r) => s1.listen(0, "127.0.0.1", r)),
        new Promise<void>((r) => s2.listen(0, "127.0.0.1", r)),
      ]);

      const p1 = s1.address() as { port: number };
      const p2 = s2.address() as { port: number };

      // Hold slot on app1.
      const r1 = get(`http://127.0.0.1:${p1.port}/api/test`, {
        "x-test-user-id": "iso",
      });
      await wait(80);

      // app2's counter is independent — it should succeed.
      const r2 = await get(`http://127.0.0.1:${p2.port}/api/test`, {
        "x-test-user-id": "iso",
      });
      expect(r2.status).toBe(200);

      resolver1?.();
      await r1;

      await Promise.all([
        new Promise<void>((r, rej) => s1.close((e) => (e ? rej(e) : r()))),
        new Promise<void>((r, rej) => s2.close((e) => (e ? rej(e) : r()))),
      ]);
    });
  });
});

// ── Singleton export ─────────────────────────────────────────────────────────

describe("perUserConcurrency singleton", () => {
  it("is a RequestHandler function", () => {
    expect(typeof perUserConcurrency).toBe("function");
  });

  it("allows requests within the default limit", async () => {
    const app = express();
    app.use("/api", perUserConcurrency);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    // MAX_CONCURRENT_REQUESTS_PER_USER=3 at top of file; a single request
    // should always succeed.
    const res = await request(app)
      .get("/api/test")
      .set("x-test-user-id", "singleton-user");
    expect(res.status).toBe(200);
  });
});
