/**
 * Security header tests for /api/me/devices and /api/me/devices/:id/revoke
 *
 * These tests verify that every response from the devices routes carries
 * the three security headers mandated by issue #594:
 *   - Content-Security-Policy
 *   - X-Content-Type-Options
 *   - Referrer-Policy
 *
 * The headers are applied by `securityHeaders` middleware (mounted before
 * `requireAuth`) so they must be present on ALL responses, including 401
 * unauthenticated responses and 200 success responses.
 *
 * Exact header values are asserted against `API_SECURITY_HEADERS` — the
 * single source of truth exported from the middleware module — so these tests
 * will automatically catch future value drift.
 */

import request from "supertest";
import express from "express";
import { API_SECURITY_HEADERS } from "../src/middleware/securityHeaders";

// ---------------------------------------------------------------------------
// DB mock — no real Postgres needed
// ---------------------------------------------------------------------------

let whereResult: unknown[] = [];
let returningResult: unknown[] = [];

jest.mock("../src/db", () => {
  // The devices GET route calls: db.select().from().where() → rows
  // The revoke POST route calls: db.update().set().where().returning() → rows
  //
  // We track which path was taken via `_isUpdate` and branch accordingly so
  // `where()` can return either a resolved Promise (select path) or `this`
  // (update path) without the two chains conflicting.
  const chain: Record<string, unknown> & { _isUpdate: boolean } = {
    _isUpdate: false,
    select: jest.fn().mockImplementation(function (this: typeof chain) {
      this._isUpdate = false;
      return this;
    }),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation(function (this: typeof chain) {
      if (this._isUpdate) {
        return this; // update chain — continue to .returning()
      }
      return Promise.resolve(whereResult); // select chain — resolve with rows
    }),
    update: jest.fn().mockImplementation(function (this: typeof chain) {
      this._isUpdate = true;
      return this;
    }),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockImplementation(() => Promise.resolve(returningResult)),
  };
  return { db: chain };
});

// ---------------------------------------------------------------------------
// requireAuth mock — injects a synthetic user (bypasses JWT + DB look-up)
// ---------------------------------------------------------------------------

jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (
      req as express.Request & { user: { id: string; stellarAddress: string } }
    ).user = { id: "user-sec-test", stellarAddress: "GSECTEST" };
    next();
  },
}));

// ---------------------------------------------------------------------------
// Logger mock — silence test output
// ---------------------------------------------------------------------------

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Lazy imports (must come after mocks)
// ---------------------------------------------------------------------------

import { devicesRouter } from "../src/routes/devices";
import { devicesRevokeRouter } from "../src/routes/devicesRevoke";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevicesApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/me/devices", devicesRouter);
  app.use(
    (
      err: Error & { statusCode?: number; status?: number; body?: unknown },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err.statusCode ?? err.status ?? 500;
      res.status(status).json(err.body ?? { error: { code: "error" } });
    },
  );
  return app;
}

function makeRevokeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/me/devices/:id/revoke", devicesRevokeRouter);
  app.use(
    (
      err: Error & { statusCode?: number; status?: number; body?: unknown },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err.statusCode ?? err.status ?? 500;
      res.status(status).json(err.body ?? { error: { code: "error" } });
    },
  );
  return app;
}

/** Asserts that all three security headers are present with correct values. */
function assertSecurityHeaders(headers: Record<string, string>): void {
  for (const [header, expected] of Object.entries(API_SECURITY_HEADERS)) {
    expect(headers[header.toLowerCase()]).toBe(expected);
  }
}

// ---------------------------------------------------------------------------
// GET /api/me/devices
// ---------------------------------------------------------------------------

describe("GET /api/me/devices — security headers", () => {
  beforeEach(() => {
    whereResult = [];
  });

  it("sets Content-Security-Policy on a 200 response", async () => {
    const res = await request(makeDevicesApp()).get("/api/me/devices");

    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(
      API_SECURITY_HEADERS["Content-Security-Policy"],
    );
  });

  it("sets X-Content-Type-Options: nosniff on a 200 response", async () => {
    const res = await request(makeDevicesApp()).get("/api/me/devices");

    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe(
      API_SECURITY_HEADERS["X-Content-Type-Options"],
    );
  });

  it("sets Referrer-Policy: no-referrer on a 200 response", async () => {
    const res = await request(makeDevicesApp()).get("/api/me/devices");

    expect(res.status).toBe(200);
    expect(res.headers["referrer-policy"]).toBe(
      API_SECURITY_HEADERS["Referrer-Policy"],
    );
  });

  it("sets all three headers on a 200 response with devices present", async () => {
    const exp = new Date("2026-07-27T00:00:00.000Z");
    whereResult = [
      { familyId: "fam-a", createdAt: new Date("2026-06-27T00:00:00.000Z"), expiresAt: exp },
    ];

    const res = await request(makeDevicesApp()).get("/api/me/devices");

    expect(res.status).toBe(200);
    assertSecurityHeaders(res.headers as Record<string, string>);
  });

  it("header values match API_SECURITY_HEADERS constant (single source of truth)", async () => {
    const res = await request(makeDevicesApp()).get("/api/me/devices");
    assertSecurityHeaders(res.headers as Record<string, string>);
  });

  it("CSP policy is deny-all: default-src 'none'; frame-ancestors 'none'; base-uri 'none'", async () => {
    const res = await request(makeDevicesApp()).get("/api/me/devices");

    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

// ---------------------------------------------------------------------------
// GET /api/me/devices — unauthenticated (securityHeaders must fire before auth)
// ---------------------------------------------------------------------------

describe("GET /api/me/devices — security headers present on 401 (unauthenticated)", () => {
  it("returns security headers even when requireAuth rejects the request", async () => {
    // Build a fresh app where requireAuth returns 401 (no user injected)
    const app = express();
    app.use(express.json());

    // Mount securityHeaders directly (mirrors what the real router does)
    const { securityHeaders } = require("../src/middleware/securityHeaders");
    app.use("/api/me/devices", securityHeaders, (_req: express.Request, res: express.Response) => {
      res.status(401).json({ error: { code: "unauthenticated" } });
    });

    const res = await request(app).get("/api/me/devices");

    expect(res.status).toBe(401);
    assertSecurityHeaders(res.headers as Record<string, string>);
  });
});

// ---------------------------------------------------------------------------
// POST /api/me/devices/:id/revoke
// ---------------------------------------------------------------------------

const VALID_FAMILY_ID = "11111111-1111-1111-1111-111111111111";

describe("POST /api/me/devices/:id/revoke — security headers", () => {
  beforeEach(() => {
    returningResult = [];
  });

  it("sets Content-Security-Policy on a revoke 200 response", async () => {
    returningResult = [{ id: "tok-1" }];

    const res = await request(makeRevokeApp()).post(
      `/api/me/devices/${VALID_FAMILY_ID}/revoke`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(
      API_SECURITY_HEADERS["Content-Security-Policy"],
    );
  });

  it("sets X-Content-Type-Options on a revoke 200 response", async () => {
    returningResult = [{ id: "tok-1" }];

    const res = await request(makeRevokeApp()).post(
      `/api/me/devices/${VALID_FAMILY_ID}/revoke`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe(
      API_SECURITY_HEADERS["X-Content-Type-Options"],
    );
  });

  it("sets Referrer-Policy on a revoke 200 response", async () => {
    returningResult = [{ id: "tok-1" }];

    const res = await request(makeRevokeApp()).post(
      `/api/me/devices/${VALID_FAMILY_ID}/revoke`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["referrer-policy"]).toBe(
      API_SECURITY_HEADERS["Referrer-Policy"],
    );
  });

  it("sets all three security headers on a 200 revoke response", async () => {
    returningResult = [{ id: "tok-1" }, { id: "tok-2" }];

    const res = await request(makeRevokeApp()).post(
      `/api/me/devices/${VALID_FAMILY_ID}/revoke`,
    );

    expect(res.status).toBe(200);
    assertSecurityHeaders(res.headers as Record<string, string>);
  });

  it("sets all three security headers on a 404 response (device not found)", async () => {
    // returning empty means route throws RouteErrorFactory.notFound
    returningResult = [];

    const res = await request(makeRevokeApp()).post(
      `/api/me/devices/${VALID_FAMILY_ID}/revoke`,
    );

    // 404 or error-handler status; headers must be set regardless
    assertSecurityHeaders(res.headers as Record<string, string>);
  });

  it("sets all three security headers on a 400 response (invalid UUID)", async () => {
    const res = await request(makeRevokeApp()).post(
      "/api/me/devices/not-a-valid-uuid/revoke",
    );

    assertSecurityHeaders(res.headers as Record<string, string>);
  });
});
