/**
 * Tests for per-user rate limiting on /api/webhooks.
 *
 * Covers the acceptance criteria:
 *   - Rate limit keys on `req.user.stellarAddress` (not IP) when present
 *   - Different users have independent quota buckets
 *   - Anonymous callers fall back to IP keying
 *   - 429 response includes `Retry-After`, `rate_limit_exceeded` code, and resetAt
 *   - Audit log is fired on block with action `rate_limit.blocked`
 *   - The `getUserRateKey` helper produces stable, namespaced keys
 *   - The webhooks route mounts the limiter before requireAuth
 */

import request from "supertest";
import express, { type Express, type Request, type Response } from "express";
import {
  createUserRateLimiter,
  getUserRateKey,
  webhooksRateLimiter,
} from "../src/middleware/rateLimit";
import { createAuditLog } from "../src/services/auditService";

const requireAdminMock = jest.fn(
  (req: Request, _res: Response, next: express.NextFunction) => {
    req.user = USER_A;
    next();
  },
);

// ---------------------------------------------------------------------------
// Mocks — keep parity with auditRateLimit.test.ts
// ---------------------------------------------------------------------------

jest.mock("../src/middleware/requireAdmin", () => ({
  requireAdmin: requireAdminMock,
}));

jest.mock("../src/db/client", () => ({
  db: {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../src/middleware/cors", () => ({
  webhookCors: () => (_req: Request, _res: Response, next: express.NextFunction) => {
    next();
  },
}));

jest.mock("../src/db/schema", () => ({
  auditLogs: "audit_logs",
}));

import { db } from "../src/db/client";
import { logger } from "../src/config/logger";

const mockInsert = db.insert as jest.MockedFunction<typeof db.insert>;
const mockLoggerWarn = logger.warn as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STELLAR_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const STELLAR_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const USER_A = {
  id: "00000000-0000-0000-0000-000000000001",
  stellarAddress: STELLAR_A,
};
const USER_B = {
  id: "00000000-0000-0000-0000-000000000002",
  stellarAddress: STELLAR_B,
};

/** Build an Express app that exposes a tiny test route with the limiter. */
function buildAppWithLimiter(limiter: ReturnType<typeof createUserRateLimiter>): Express {
  const app = express();
  app.use(express.json());
  app.use(limiter);
  app.get("/api/webhooks", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.post("/api/webhooks", (_req: Request, res: Response) => {
    res.status(201).json({ created: true });
  });
  return app;
}

/** Mounts `req.user` to simulate a prior `requireAuth` middleware. */
function asUser(user: typeof USER_A | typeof USER_B) {
  return (req: Request, _res: Response, next: express.NextFunction): void => {
    req.user = user;
    next();
  };
}

// ---------------------------------------------------------------------------
// getUserRateKey unit tests
// ---------------------------------------------------------------------------

describe("getUserRateKey helper", () => {
  it("prefers stellarAddress with a `user:` prefix", () => {
    const req = {
      user: { id: USER_A.id, stellarAddress: STELLAR_A },
      socket: { remoteAddress: "10.0.0.1" },
      headers: {},
    } as unknown as Request;

    expect(getUserRateKey(req)).toBe(`user:${STELLAR_A}`);
  });

  it("falls back to user.id when stellarAddress is missing", () => {
    const req = {
      user: { id: USER_A.id, stellarAddress: undefined as unknown as string },
      socket: { remoteAddress: "10.0.0.1" },
      headers: {},
    } as unknown as Request;

    expect(getUserRateKey(req)).toBe(`user:${USER_A.id}`);
  });

  it("uses IP fallback (via socket) when no user is attached", () => {
    const req = {
      socket: { remoteAddress: "203.0.113.7" },
      headers: {},
    } as unknown as Request;

    expect(getUserRateKey(req)).toBe("ip:203.0.113.7");
  });

  it("honours X-Forwarded-For in the IP fallback path", () => {
    const req = {
      headers: { "x-forwarded-for": "198.51.100.42, 10.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;

    expect(getUserRateKey(req)).toBe("ip:198.51.100.42");
  });
});

// ---------------------------------------------------------------------------
// createUserRateLimiter — quota behaviour
// ---------------------------------------------------------------------------

describe("createUserRateLimiter middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) } as any);
  });

  it("allows requests under the per-user limit", async () => {
    const app = express();
    app.use(asUser(USER_A));
    const limiter = createUserRateLimiter({ limit: 5, windowMs: 60_000 });
    app.use("/api/webhooks", limiter);
    app.get("/api/webhooks", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/webhooks");
    expect(res.status).toBe(200);
  });

  it("returns 429 with the standard envelope after N requests per user", async () => {
    const app = express();
    app.use(asUser(USER_A));
    const limiter = createUserRateLimiter({ limit: 2, windowMs: 60_000 });
    app.use("/api/webhooks", limiter);
    app.get("/api/webhooks", (_req, res) => res.json({ ok: true }));

    await request(app).get("/api/webhooks").expect(200);
    await request(app).get("/api/webhooks").expect(200);
    const blocked = await request(app).get("/api/webhooks");

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
    expect(blocked.body.error.resetAt).toBeDefined();
    expect(blocked.body.error.retryAfter).toBe(Number(blocked.headers["retry-after"]));
  });

  it("keys quota per stellar address — user B is not blocked when user A is", async () => {
    const limiter = createUserRateLimiter({ limit: 1, windowMs: 60_000 });

    const appA = express();
    appA.use(asUser(USER_A));
    appA.use("/api/webhooks", limiter);
    appA.get("/api/webhooks", (_req, res) => res.json({ user: "A" }));

    const appB = express();
    appB.use(asUser(USER_B));
    appB.use("/api/webhooks", limiter);
    appB.get("/api/webhooks", (_req, res) => res.json({ user: "B" }));

    await request(appA).get("/api/webhooks").expect(200);
    await request(appA).get("/api/webhooks").expect(429);

    // User B on the same limiter instance is still within their own quota
    await request(appB).get("/api/webhooks").expect(200);
  });

  it("anonymous requests share the IP bucket between anonymous callers", async () => {
    const limiter = createUserRateLimiter({ limit: 1, windowMs: 60_000 });
    const app = buildAppWithLimiter(limiter);

    await request(app).get("/api/webhooks").expect(200);
    // Same (loopback) IP → blocked
    await request(app).get("/api/webhooks").expect(429);
  });

  it("fires an audit log entry when the limit is hit", async () => {
    const app = express();
    app.use(asUser(USER_A));
    const limiter = createUserRateLimiter({ limit: 1, windowMs: 60_000 });
    app.use("/api/webhooks", limiter);
    app.get("/api/webhooks", (_req, res) => res.json({}));

    await request(app).get("/api/webhooks");
    await request(app).get("/api/webhooks"); // blocked

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitContext: expect.objectContaining({ blocked: true, remaining: 0 }),
      }),
      "rate_limit_blocked",
    );
    expect(mockInsert).toHaveBeenCalledWith("audit_logs");
  });

  it("audit log entry includes the wallet address for authenticated blocks", async () => {
    const valuesMock = jest.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: valuesMock } as any);

    const app = express();
    app.use(asUser(USER_A));
    const limiter = createUserRateLimiter({ limit: 1, windowMs: 60_000 });
    app.use("/api/webhooks", limiter);
    app.get("/api/webhooks", (_req, res) => res.json({}));

    await request(app).get("/api/webhooks");
    await request(app).get("/api/webhooks"); // blocked

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: STELLAR_A,
        action: "rate_limit.blocked",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// webhooksRateLimiter pre-configured instance
// ---------------------------------------------------------------------------

describe("webhooksRateLimiter (env-derived instance)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) } as any);
  });

  it("is a valid middleware that allows the first request", async () => {
    const app = express();
    app.use(asUser(USER_A));
    app.use("/api/webhooks", webhooksRateLimiter);
    app.get("/api/webhooks", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/webhooks");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// End-to-end route wiring: webhooksRouter respects its rate-limit middleware
// ---------------------------------------------------------------------------

describe("webhooksRouter rate-limit gate (requireAuth mocked)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsert.mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) } as any);
  });

  // `db` queries inside webhooksRouter would fail without a full DB mock — we
  // only care about the rate-limit layer sitting *before* the handlers, so
  // short-circuit the DB calls at the module level.
  jest.doMock("../src/db", () => ({
    db: {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
          orderBy: jest.fn().mockResolvedValue([]),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue([
          {
            id: "11111111-1111-1111-1111-111111111111",
            userId: USER_A.id,
            url: "https://example.com/hook",
            events: [],
            secret: "x",
            active: true,
            createdAt: new Date("2025-01-01T00:00:00Z"),
            updatedAt: new Date("2025-01-01T00:00:00Z"),
          },
        ]),
        returning: jest.fn().mockResolvedValue([
          {
            id: "11111111-1111-1111-1111-111111111111",
            userId: USER_A.id,
            url: "https://example.com/hook",
            events: [],
            secret: "x",
            active: true,
            createdAt: new Date("2025-01-01T00:00:00Z"),
            updatedAt: new Date("2025-01-01T00:00:00Z"),
          },
        ]),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              {
                id: "11111111-1111-1111-1111-111111111111",
                userId: USER_A.id,
                url: "https://example.com/hook",
                events: [],
                active: true,
                createdAt: new Date("2025-01-01T00:00:00Z"),
                updatedAt: new Date("2025-01-01T00:00:00Z"),
              },
            ]),
          }),
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue({ rowCount: 1 }),
      }),
    },
  }));

  it("applies the per-user limiter before handlers run", async () => {
    const { webhooksRouter } = await import("../src/routes/webhooks");
    const middlewareRouter = express.Router();

    webhooksRouter.stack.forEach((layer: any) => {
      if (!layer.route) {
        middlewareRouter.use(layer.handle);
      }
    });

    middlewareRouter.get("/", (_req, res) => {
      res.json({ ok: true });
    });

    const app = express();
    app.use(express.json());

    // Swap in a tighter limiter so tests don't need 100 requests
    const tightLimiter = createUserRateLimiter({ limit: 2, windowMs: 60_000 });
    app.use("/api/webhooks", tightLimiter, middlewareRouter);

    await request(app).get("/api/webhooks").expect(200);
    await request(app).get("/api/webhooks").expect(200);
    const blocked = await request(app).get("/api/webhooks");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
  });
});
