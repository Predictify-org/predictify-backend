/**
 * Tests for:
 *  - src/services/marketAdmin.ts  (forceFinalize service, unit)
 *  - src/routes/adminMarkets.ts   (POST /api/admin/markets/:id/force-finalize, integration)
 */

// ── Env setup (must be before any src imports) ────────────────────────────────
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF1234567890";
process.env.ADMIN_ALLOWLIST = "GADMIN111111111111111111111111111111111111111111111111111111";

// ── Route tests use a mocked service ─────────────────────────────────────────
jest.mock("../src/db", () => ({ db: {} }));
jest.mock("../src/db/client", () => ({ db: {} }));
jest.mock("../src/services/marketAdmin");

import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { adminMarketsRouter } from "../src/routes/adminMarkets";
import * as marketAdminModule from "../src/services/marketAdmin";
import { env } from "../src/config/env";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_ADDRESS = "GADMIN111111111111111111111111111111111111111111111111111111";
const USER_ADDRESS  = "GUSER2222222222222222222222222222222222222222222222222222222";

function signJwt(address: string): string {
  return jwt.sign(
    { sub: address },
    env.JWT_SECRET,
    { audience: env.JWT_AUDIENCE, issuer: env.JWT_ISSUER },
  );
}

const adminToken = signJwt(ADMIN_ADDRESS);
const userToken  = signJwt(USER_ADDRESS);

function simpleErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status = (err as { status?: number }).status ?? 500;
  const code = (err as { code?: string }).code ?? "internal_error";
  res.status(status).json({ error: { code } });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/markets", adminMarketsRouter);
  app.use(simpleErrorHandler);
  return app;
}

// Cast to access jest mock methods
const mockedForceFinalize = marketAdminModule.forceFinalize as jest.MockedFunction<typeof marketAdminModule.forceFinalize>;

// ── Route tests ───────────────────────────────────────────────────────────────

describe("POST /api/admin/markets/:id/force-finalize", () => {
  afterEach(() => jest.clearAllMocks());

  it("401 — missing Authorization header", async () => {
    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .send({ winningOutcome: "yes" });
    expect(res.status).toBe(401);
  });

  it("403 — non-admin address rejected", async () => {
    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ winningOutcome: "yes" });
    expect(res.status).toBe(403);
  });

  it("400 — missing winningOutcome", async () => {
    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("400 — empty winningOutcome string", async () => {
    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("404 — market not found", async () => {
    const err: any = new Error("Market not found");
    err.status = 404;
    mockedForceFinalize.mockRejectedValueOnce(err);

    const res = await request(buildApp())
      .post("/api/admin/markets/unknown/force-finalize")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("422 — deadline not yet reached", async () => {
    const err: any = new Error("Market has not yet reached its resolution deadline");
    err.status = 422;
    mockedForceFinalize.mockRejectedValueOnce(err);

    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("deadline_not_reached");
  });

  it("409 — market already force-finalized", async () => {
    mockedForceFinalize.mockResolvedValueOnce({ phase: "already_finalized" });

    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_finalized");
  });

  it("200 — phase 1 preview (no ?confirm)", async () => {
    mockedForceFinalize.mockResolvedValueOnce({
      phase: "preview",
      marketId: "mkt-1",
      currentStatus: "open",
      resolutionTime: "2025-01-01T00:00:00.000Z",
      requiresConfirm: true,
    });

    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(200);
    expect(res.body.data.phase).toBe("preview");
    expect(res.body.data.requiresConfirm).toBe(true);
    expect(mockedForceFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ marketId: "mkt-1", winningOutcome: "yes" }),
      false,
    );
  });

  it("200 — phase 2 finalized (?confirm=true)", async () => {
    mockedForceFinalize.mockResolvedValueOnce({
      phase: "finalized",
      marketId: "mkt-1",
      winningOutcome: "yes",
      forceFinalized: true,
    });

    const res = await request(buildApp())
      .post("/api/admin/markets/mkt-1/force-finalize?confirm=true")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(200);
    expect(res.body.data.phase).toBe("finalized");
    expect(res.body.data.forceFinalized).toBe(true);
    expect(mockedForceFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ marketId: "mkt-1", winningOutcome: "yes", adminAddress: ADMIN_ADDRESS }),
      true,
    );
  });
});

// ── Service unit tests ────────────────────────────────────────────────────────
// Use the actual (unmocked) implementation via jest.requireActual

const { forceFinalize: realForceFinalize } = jest.requireActual<typeof marketAdminModule>("../src/services/marketAdmin");

const PAST_DATE   = new Date(Date.now() - 86_400_000); // yesterday
const FUTURE_DATE = new Date(Date.now() + 86_400_000); // tomorrow

function buildMockDb(marketRow: Record<string, unknown> | null) {
  const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
  const txUpdate = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  });

  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(marketRow ? [marketRow] : []),
        }),
      }),
    }),
    transaction: jest.fn(async (cb: (tx: any) => Promise<void>) => {
      await cb({ update: txUpdate, insert: txInsert });
    }),
    _txInsert: txInsert,
    _txUpdate: txUpdate,
  };
}

describe("forceFinalize service", () => {
  it("throws 404 when market not found", async () => {
    const db = buildMockDb(null) as any;
    await expect(
      realForceFinalize(db, { marketId: "x", winningOutcome: "yes", adminAddress: "G..." }, true),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns already_finalized when forceFinalized = true", async () => {
    const db = buildMockDb({
      id: "mkt-1",
      status: "resolved",
      forceFinalized: true,
      resolutionTime: PAST_DATE,
      winningOutcome: "yes",
      version: 2,
    }) as any;
    const result = await realForceFinalize(
      db,
      { marketId: "mkt-1", winningOutcome: "yes", adminAddress: "G..." },
      true,
    );
    expect(result).toEqual({ phase: "already_finalized" });
  });

  it("throws 422 when resolution deadline is in the future", async () => {
    const db = buildMockDb({
      id: "mkt-1",
      status: "open",
      forceFinalized: false,
      resolutionTime: FUTURE_DATE,
      winningOutcome: null,
      version: 1,
    }) as any;
    await expect(
      realForceFinalize(db, { marketId: "mkt-1", winningOutcome: "yes", adminAddress: "G..." }, false),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("returns preview when confirm = false and market is eligible", async () => {
    const db = buildMockDb({
      id: "mkt-1",
      status: "open",
      forceFinalized: false,
      resolutionTime: PAST_DATE,
      winningOutcome: null,
      version: 1,
    }) as any;
    const result = await realForceFinalize(
      db,
      { marketId: "mkt-1", winningOutcome: "yes", adminAddress: "G..." },
      false,
    );
    expect(result).toMatchObject({ phase: "preview", requiresConfirm: true });
  });

  it("finalizes market and writes audit log when confirm = true", async () => {
    const db = buildMockDb({
      id: "mkt-1",
      status: "open",
      forceFinalized: false,
      resolutionTime: PAST_DATE,
      winningOutcome: null,
      version: 1,
    }) as any;

    const result = await realForceFinalize(
      db,
      { marketId: "mkt-1", winningOutcome: "yes", adminAddress: "GADMIN..." },
      true,
    );

    expect(result).toEqual({
      phase: "finalized",
      marketId: "mkt-1",
      winningOutcome: "yes",
      forceFinalized: true,
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db._txUpdate).toHaveBeenCalled();
    expect(db._txInsert).toHaveBeenCalled();
  });
});
