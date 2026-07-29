/**
 * Unit tests for /api/referrals endpoints.
 *
 * All external I/O is mocked via injectable dependencies, so no database or
 * network access is required.
 */

// ── Environment stubs (must be set before any module import) ─────────────────
process.env.JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-000000";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ── Mock pg and drizzle before any imports ─────────────────────────────────
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({})),
}));

// Mock requireAuth to avoid real DB lookups
const MOCK_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MOCK_USER_ADDR = "GUSER88888888888888888888888888888888888888888888888888888";

jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: MOCK_USER_ID, stellarAddress: MOCK_USER_ADDR };
    next();
  },
}));

// Mock db client so referralService doesn't open a real connection
// Build a chain: db.insert().values() -> db.select().from().where().orderBy()
const mockValues = jest.fn();
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockOrderBy = jest.fn();
const mockWhere = jest.fn(() => ({ orderBy: mockOrderBy }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("../src/db/client", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
  },
}));

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { AuditEntryInput } from "../src/services/auditService";
import {
  createReferralsRouter,
  type ReferralsRouterDeps,
  type ReferralsRouterOptions,
} from "../src/routes/referrals";
import type { ReferralResult, CreateReferralInput } from "../src/services/referralService";
import type { Referral } from "../src/db/schema";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Test constants ───────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET!, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const userJwt = signJwt({ sub: MOCK_USER_ADDR, role: "user" });

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(
  deps: ReferralsRouterDeps = {},
  opts: ReferralsRouterOptions = {},
): express.Express {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "referrals-req";
    next();
  });

  app.use("/api/referrals", createReferralsRouter(opts, deps));
  app.use(errorHandler);
  return app;
}

// ── Stubs ────────────────────────────────────────────────────────────────────

const MOCK_REFERRAL_CODE = "REF-TEST-0001";
const MOCK_CREATE_RESULT: ReferralResult = {
  referralCode: MOCK_REFERRAL_CODE,
  message: "Referral created successfully",
};

const MOCK_REFERRALS: Referral[] = [
  {
    id: "ref-001-0000-0000-0000-000000000001",
    userId: MOCK_USER_ID,
    referralCode: "REF-ABC-123",
    campaignId: "FWC26",
    referredUser: null,
    status: "pending",
    createdAt: new Date("2026-07-28T12:00:00.000Z"),
  },
  {
    id: "ref-002-0000-0000-0000-000000000002",
    userId: MOCK_USER_ID,
    referralCode: "REF-DEF-456",
    campaignId: null,
    referredUser: "GD2REFERREDUSER123",
    status: "completed",
    createdAt: new Date("2026-07-27T12:00:00.000Z"),
  },
];

function makeStubs(overrides: {
  createError?: Error;
  listError?: Error;
} = {}): ReferralsRouterDeps {
  return {
    createReferral: jest.fn<
      Promise<ReferralResult>,
      [CreateReferralInput]
    >(async () => {
      if (overrides.createError) throw overrides.createError;
      return MOCK_CREATE_RESULT;
    }),
    listUserReferrals: jest.fn<
      Promise<Referral[]>,
      [string]
    >(async () => {
      if (overrides.listError) throw overrides.listError;
      return MOCK_REFERRALS;
    }),
    auditLogger: jest.fn<Promise<string>, [AuditEntryInput]>(
      async () => "test-correlation-id",
    ),
  };
}


// ── POST validation ────────────────────────────────────────────────────────

describe("POST /api/referrals — validation", () => {
  it("accepts an empty body (no campaignId)", async () => {
    const stubs = makeStubs();
    const res = await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(201);
  });

  it("accepts a valid campaignId", async () => {
    const stubs = makeStubs();
    const res = await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ campaignId: "FWC26" });
    expect(res.status).toBe(201);
  });

  it("rejects a non-string campaignId", async () => {
    const stubs = makeStubs();
    const res = await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ campaignId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(stubs.createReferral).not.toHaveBeenCalled();
  });
});

// ── POST success ──────────────────────────────────────────────────────────

describe("POST /api/referrals — success", () => {
  it("creates a referral code and returns 201", async () => {
    const stubs = makeStubs();
    const res = await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ campaignId: "FWC26" });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      referralCode: MOCK_REFERRAL_CODE,
      message: "Referral created successfully",
    });
  });

  it("emits correlationId header", async () => {
    const stubs = makeStubs();
    const res = await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .set("X-Request-Id", "trace-create")
      .send({ campaignId: "FWC26" });
    expect(res.status).toBe(201);
    expect(res.headers["x-correlation-id"]).toBe("trace-create");
  });

  it("writes audit log with action=referral.create", async () => {
    const stubs = makeStubs();
    await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ campaignId: "FWC26" });
    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ action: "referral.create" }),
    );
  });

  it("audit log captures actor, beforeState, afterState", async () => {
    const stubs = makeStubs();
    await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({ campaignId: "FWC26" });
    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: MOCK_USER_ADDR,
        beforeState: null,
        afterState: { referralCode: MOCK_REFERRAL_CODE, campaignId: "FWC26" },
      }),
    );
  });

  it("audit log captures IP from x-forwarded-for", async () => {
    const stubs = makeStubs();
    await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .set("X-Forwarded-For", "198.51.100.7")
      .send({ campaignId: "FWC26" });
    expect(stubs.auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "198.51.100.7" }),
    );
  });
});

// ── GET success ───────────────────────────────────────────────────────────

describe("GET /api/referrals — success", () => {
  it("returns the list of referrals", async () => {
    const stubs = makeStubs();
    const res = await request(makeApp(stubs))
      .get("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("returns empty list when user has no referrals", async () => {
    const stubs = makeStubs();
    stubs.listUserReferrals.mockResolvedValueOnce([]);
    const res = await request(makeApp(stubs))
      .get("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("POST: returns 429 after limit exceeded", async () => {
    const stubs = makeStubs();
    const app = makeApp(stubs, { rateLimitPerMinute: 1 });
    const first = await request(app)
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(second.status).toBe(429);
  });

  it("GET: returns 429 after limit exceeded", async () => {
    const stubs = makeStubs();
    const app = makeApp(stubs, { rateLimitPerMinute: 1 });
    const first = await request(app)
      .get("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(first.status).toBe(200);
    const second = await request(app)
      .get("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(second.status).toBe(429);
  });
});

// ── Error propagation ────────────────────────────────────────────────────

describe("error propagation", () => {
  it("POST: 500 on create error, audit NOT written", async () => {
    const stubs = makeStubs({ createError: new Error("db write failure") });
    const res = await request(makeApp(stubs))
      .post("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(500);
    expect(stubs.auditLogger).not.toHaveBeenCalled();
  });

  it("GET: 500 on list error", async () => {
    const stubs = makeStubs({ listError: new Error("db read failure") });
    const res = await request(makeApp(stubs))
      .get("/api/referrals")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(500);
  });
});
