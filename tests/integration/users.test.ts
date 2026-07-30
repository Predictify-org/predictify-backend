/**
 * End-to-end integration tests for `/api/users`.
 *
 * Unlike the unit suites under `tests/`, nothing here is mocked: the routers
 * are mounted on a real Express app and every query hits the Testcontainers
 * Postgres instance provisioned by `tests/integration/globalSetup.js` with the
 * real Drizzle migrations applied.
 *
 * Coverage:
 *   GET /api/users/me                     — auth (403) + aggregate totals
 *   GET /api/users/:address/predictions   — validation, 404, filtering,
 *                                           keyset pagination, tenant isolation
 *   GET /api/users/:addr/portfolio        — validation, 404, aggregation
 *   GET /api/users/:address/profile       — validation (422) + 404
 *
 * `pg.Pool` is subclassed so every pool opened by the modules under test
 * (`src/db/client` and `src/middleware/requireAuth` each create their own) can
 * be closed in `afterAll`; otherwise idle clients keep the Jest worker alive.
 */

jest.mock("pg", () => {
  const actual = jest.requireActual<typeof import("pg")>("pg");
  const globalWithPools = globalThis as typeof globalThis & {
    __integrationPgPools?: InstanceType<typeof actual.Pool>[];
  };
  globalWithPools.__integrationPgPools = globalWithPools.__integrationPgPools ?? [];

  class TrackedPool extends actual.Pool {
    constructor(config?: ConstructorParameters<typeof actual.Pool>[0]) {
      super(config);
      globalWithPools.__integrationPgPools!.push(this);
    }
  }

  return { ...actual, Pool: TrackedPool };
});

import express, { type Express } from "express";
import request from "supertest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { claims, markets, predictions, users } from "../../src/db/schema";
import { usersRouter } from "../../src/routes/users";
import { userPortfolioRouter } from "../../src/routes/users/portfolio";
import { errorHandler } from "../../src/middleware/errorHandler";
import { requestContextStorage } from "../../src/lib/requestContext";
import { signAccessToken } from "../../src/services/jwtService";
import { clearUserPortfolioCache } from "../../src/services/userPortfolioService";
import { decodeCursor } from "../../src/utils/cursor";

/** Builds a syntactically valid Stellar address (`G` + 55 base32 chars). */
function stellarAddress(seed: string): string {
  return `G${seed.toUpperCase().padEnd(55, "A").slice(0, 55)}`;
}

const ALICE = stellarAddress("ALICE");
const BOB = stellarAddress("BOB");
const UNKNOWN = stellarAddress("NOBODY");
const INVALID = "not-a-stellar-address";

const MARKET_ID = "integration-users-market";
const ALICE_PREDICTIONS = 25;
const BOB_PREDICTIONS = 3;

/**
 * Mirrors the `/api/users` mounting order in `src/index.ts` without importing
 * the whole app, so this suite exercises the routers plus the shared
 * request-context and error-handling middleware only.
 */
function buildApp(): Express {
  const app = express();
  app.set("etag", false);
  app.use((_req, _res, next) => {
    requestContextStorage.run({ requestId: "integration-test" }, next);
  });
  app.use("/api/users", userPortfolioRouter);
  app.use("/api/users", usersRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

let aliceId: string;
let bobId: string;

async function seed(): Promise<void> {
  const inserted = await db
    .insert(users)
    .values([{ stellarAddress: ALICE }, { stellarAddress: BOB }])
    .returning({ id: users.id, stellarAddress: users.stellarAddress });

  aliceId = inserted.find((u) => u.stellarAddress === ALICE)!.id;
  bobId = inserted.find((u) => u.stellarAddress === BOB)!.id;

  await db.insert(markets).values({
    id: MARKET_ID,
    question: "Will XLM close above $1 this year?",
    status: "active",
    resolutionTime: new Date("2030-01-01T00:00:00.000Z"),
    indexedLedger: 1,
  });

  // Distinct, strictly decreasing timestamps keep the (createdAt DESC, id DESC)
  // keyset order deterministic across pages.
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  await db.insert(predictions).values(
    Array.from({ length: ALICE_PREDICTIONS }, (_, i) => ({
      marketId: MARKET_ID,
      userId: aliceId,
      outcome: i % 2 === 0 ? "yes" : "no",
      amount: "100",
      status: i < 10 ? "pending" : i < 15 ? "confirmed" : "won",
      createdAt: new Date(base - i * 60_000),
    })),
  );

  await db.insert(predictions).values(
    Array.from({ length: BOB_PREDICTIONS }, (_, i) => ({
      marketId: MARKET_ID,
      userId: bobId,
      outcome: "yes",
      amount: "50",
      status: "pending",
      createdAt: new Date(base - i * 60_000),
    })),
  );

  await db.insert(claims).values({
    userId: aliceId,
    marketId: MARKET_ID,
    amount: "700",
    status: "pending",
  });
}

async function cleanup(): Promise<void> {
  await db.delete(claims).where(eq(claims.marketId, MARKET_ID));
  await db.delete(predictions).where(eq(predictions.marketId, MARKET_ID));
  await db.delete(markets).where(eq(markets.id, MARKET_ID));
  await db.delete(users).where(eq(users.stellarAddress, ALICE));
  await db.delete(users).where(eq(users.stellarAddress, BOB));
}

interface PredictionRow {
  id: string;
  marketId: string;
  question: string;
  outcome: string;
  amount: string;
  status: string;
  createdAt: string;
  resolutionTime: string;
}

beforeAll(async () => {
  await cleanup();
  await seed();
});

afterAll(async () => {
  await cleanup();
  clearUserPortfolioCache();
  const pools = (globalThis as typeof globalThis & { __integrationPgPools?: Pool[] })
    .__integrationPgPools ?? [];
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
});

describe("GET /api/users/me", () => {
  it("rejects anonymous callers with 403", async () => {
    const res = await request(app).get("/api/users/me");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("rejects a forged token with 403", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", "Bearer not.a.jwt");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("rejects a well-signed token for a user that no longer exists", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signAccessToken({ sub: UNKNOWN })}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns the profile and prediction totals of the authenticated user", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signAccessToken({ sub: ALICE })}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      stellarAddress: ALICE,
      totals: { prediction_count: ALICE_PREDICTIONS, claim_count: 0 },
    });
    expect(new Date(res.body.data.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("scopes totals to the caller", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${signAccessToken({ sub: BOB })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totals.prediction_count).toBe(BOB_PREDICTIONS);
  });
});

describe("GET /api/users/:address/predictions", () => {
  it("rejects a malformed address with 400 invalid_address", async () => {
    const res = await request(app).get(`/api/users/${INVALID}/predictions`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_address");
  });

  it.each([
    ["limit=0", "limit=0"],
    ["limit=101", "limit=101"],
    ["limit=abc", "limit=abc"],
    ["unknown status", "status=exploded"],
  ])("rejects %s with 400 validation_error", async (_label, query) => {
    const res = await request(app).get(`/api/users/${ALICE}/predictions?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 404 for a valid address with no user row", async () => {
    const res = await request(app).get(`/api/users/${UNKNOWN}/predictions`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns the default page size and joined market fields", async () => {
    const res = await request(app).get(`/api/users/${ALICE}/predictions`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.nextCursor).toEqual(expect.any(String));
    expect(res.body.data[0]).toMatchObject({
      marketId: MARKET_ID,
      question: "Will XLM close above $1 this year?",
      amount: "100",
    });
  });

  it("orders rows by createdAt descending", async () => {
    const res = await request(app).get(`/api/users/${ALICE}/predictions?limit=25`);
    const timestamps = (res.body.data as PredictionRow[]).map((row) =>
      Date.parse(row.createdAt),
    );

    expect(res.status).toBe(200);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("filters by status", async () => {
    const res = await request(app).get(
      `/api/users/${ALICE}/predictions?status=confirmed&limit=100`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(
      (res.body.data as PredictionRow[]).every((row) => row.status === "confirmed"),
    ).toBe(true);
    expect(res.body.nextCursor).toBeNull();
  });

  it("walks every row exactly once across cursor pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = `/api/users/${ALICE}/predictions?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      seen.push(...(res.body.data as PredictionRow[]).map((row) => row.id));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(ALICE_PREDICTIONS);
    expect(new Set(seen).size).toBe(ALICE_PREDICTIONS);
  });

  it("emits a cursor that decodes to the last row of the page", async () => {
    const res = await request(app).get(`/api/users/${ALICE}/predictions?limit=5`);
    const rows = res.body.data as PredictionRow[];

    expect(decodeCursor(res.body.nextCursor)).toEqual({
      sortValue: rows[rows.length - 1].createdAt,
      id: rows[rows.length - 1].id,
    });
  });

  it("restarts from page one when the cursor is tampered with", async () => {
    const first = await request(app).get(`/api/users/${ALICE}/predictions?limit=5`);
    const tampered = await request(app).get(
      `/api/users/${ALICE}/predictions?limit=5&cursor=not-a-valid-cursor`,
    );

    expect(tampered.status).toBe(200);
    expect((tampered.body.data as PredictionRow[]).map((r) => r.id)).toEqual(
      (first.body.data as PredictionRow[]).map((r) => r.id),
    );
  });

  it("never leaks another user's predictions", async () => {
    const res = await request(app).get(`/api/users/${BOB}/predictions?limit=100`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(BOB_PREDICTIONS);
    expect((res.body.data as PredictionRow[]).every((row) => row.amount === "50")).toBe(
      true,
    );
  });
});

describe("GET /api/users/:addr/portfolio", () => {
  beforeEach(() => {
    clearUserPortfolioCache();
  });

  it("rejects a malformed address with 400 invalid_address", async () => {
    const res = await request(app).get(`/api/users/${INVALID}/portfolio`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_address");
  });

  it("returns 404 for a valid address with no user row", async () => {
    const res = await request(app).get(`/api/users/${UNKNOWN}/portfolio`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("aggregates stakes, claims and per-status counts", async () => {
    const res = await request(app).get(`/api/users/${ALICE}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      address: ALICE,
      totals: {
        marketCount: 1,
        predictionCount: ALICE_PREDICTIONS,
        totalStaked: String(ALICE_PREDICTIONS * 100),
        claimableAmount: "700",
        pending: 10,
        confirmed: 5,
        won: 10,
        lost: 0,
        claimed: 0,
      },
    });
    expect(res.body.data.markets).toHaveLength(1);
    expect(res.body.data.markets[0]).toMatchObject({
      marketId: MARKET_ID,
      predictionCount: ALICE_PREDICTIONS,
      totalStaked: String(ALICE_PREDICTIONS * 100),
    });
  });
});

describe("GET /api/users/:address/profile", () => {
  it("rejects a malformed address with a 400 envelope", async () => {
    const res = await request(app).get(`/api/users/${INVALID}/profile`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "BadRequest",
      message: "Invalid Stellar address",
    });
  });

  it("returns a 404 envelope for an address with no profile", async () => {
    const res = await request(app).get(`/api/users/${UNKNOWN}/profile`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ type: "NotFound" });
  });
});
