import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createAdminReconciliationRouter } from "../src/routes/admin/reconciliation";
import { errorHandler } from "../src/middleware/errorHandler";

jest.mock("../src/services/reconciliationService", () => ({
  reconcileMarket: jest.fn(),
}));

import { reconcileMarket } from "../src/services/reconciliationService";

const mockReconcileMarket = reconcileMarket as jest.MockedFunction<
  typeof reconcileMarket
>;

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDRESS =
  "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS =
  "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ??
      "generated-request-id";
    next();
  });
  app.use("/api/admin/recon", createAdminReconciliationRouter());
  app.use(errorHandler);
  return app;
}

describe("GET /api/admin/recon/markets/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 without an admin token", async () => {
    const res = await request(makeApp()).get(
      "/api/admin/recon/markets/market-1",
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 200 with a structured diff payload", async () => {
    mockReconcileMarket.mockResolvedValue({
      marketId: "market-1",
      correlationId: "recon-123",
      generatedAt: "2026-06-27T12:00:00.000Z",
      status: "ok",
      dbSnapshot: {
        positions: [{ stellarAddress: "G1", outcome: "yes", amount: "100" }],
        totalAmount: "100",
      },
      onChainSnapshot: {
        positions: [{ stellarAddress: "G1", outcome: "yes", amount: "90" }],
        totalAmount: "90",
        available: true,
        source: "soroban-rpc",
        unavailableReason: null,
      },
      summary: {
        totalKeys: 1,
        matches: 0,
        mismatches: 1,
        missingOnChain: 0,
        missingInDb: 0,
      },
      diffs: [
        {
          key: { stellarAddress: "G1", outcome: "yes" },
          dbAmount: "100",
          onChainAmount: "90",
          difference: "10",
          status: "mismatch",
        },
      ],
    });

    const res = await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      )
      .set("X-Request-Id", "recon-123");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("recon-123");
    expect(res.body.data.summary).toEqual({
      totalKeys: 1,
      matches: 0,
      mismatches: 1,
      missingOnChain: 0,
      missingInDb: 0,
    });
    expect(res.body.data.diffs[0]).toEqual({
      key: { stellarAddress: "G1", outcome: "yes" },
      dbAmount: "100",
      onChainAmount: "90",
      difference: "10",
      status: "mismatch",
    });
    expect(mockReconcileMarket).toHaveBeenCalledWith({
      marketId: "market-1",
      adminAddress: ADMIN_ADDRESS,
      ip: expect.any(String),
      correlationId: "recon-123",
    });
  });

  it("returns 400 for an empty market id", async () => {
    const res = await request(makeApp())
      .get("/api/admin/recon/markets/%20")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      )
      .set("X-Request-Id", "bad-request-id");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.requestId).toBe("bad-request-id");
  });

  it("surfaces service not_found via the standardized envelope", async () => {
    const error = Object.assign(new Error("missing"), {
      status: 404,
      code: "not_found",
    });
    mockReconcileMarket.mockRejectedValue(error);

    const res = await request(makeApp())
      .get("/api/admin/recon/markets/missing-market")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      )
      .set("X-Request-Id", "missing-request");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "not_found",
        requestId: "missing-request",
      },
    });
  });

  it("returns 403 for non-admin JWTs", async () => {
    const res = await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: USER_ADDRESS, role: "user" })}`,
      );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });
});
