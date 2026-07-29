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

/** Minimal valid reconciliation result for reuse across tests. */
function makeResult(
  overrides: Partial<Awaited<ReturnType<typeof reconcileMarket>>> = {},
): Awaited<ReturnType<typeof reconcileMarket>> {
  return {
    marketId: "market-1",
    correlationId: "recon-123",
    generatedAt: "2026-06-27T12:00:00.000Z",
    status: "ok",
    dbSnapshot: {
      positions: [{ stellarAddress: "G1", outcome: "yes", amount: "100" }],
      totalAmount: "100",
    },
    onChainSnapshot: {
      positions: [{ stellarAddress: "G1", outcome: "yes", amount: "100" }],
      totalAmount: "100",
      available: true,
      source: "soroban-rpc",
      unavailableReason: null,
    },
    summary: {
      totalKeys: 1,
      matches: 1,
      mismatches: 0,
      missingOnChain: 0,
      missingInDb: 0,
    },
    diffs: [
      {
        key: { stellarAddress: "G1", outcome: "yes" },
        dbAmount: "100",
        onChainAmount: "100",
        difference: "0",
        status: "match",
      },
    ],
    ...overrides,
  };
}

describe("GET /api/admin/recon/markets/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Auth guards ────────────────────────────────────────────────────────────

  it("returns 403 without any token", async () => {
    const res = await request(makeApp()).get(
      "/api/admin/recon/markets/market-1",
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
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

  it("returns 403 for a malformed bearer token", async () => {
    const res = await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set("Authorization", "Bearer not.a.valid.jwt");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns 200 with a full structured diff payload on mismatch", async () => {
    mockReconcileMarket.mockResolvedValue(
      makeResult({
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
      }),
    );

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

  it("returns 200 with status partial when on-chain data is unavailable", async () => {
    mockReconcileMarket.mockResolvedValue(
      makeResult({
        status: "partial",
        onChainSnapshot: {
          positions: [],
          totalAmount: "0",
          available: false,
          source: "soroban-rpc",
          unavailableReason: "adapter not configured",
        },
        summary: {
          totalKeys: 1,
          matches: 0,
          mismatches: 0,
          missingOnChain: 1,
          missingInDb: 0,
        },
        diffs: [
          {
            key: { stellarAddress: "G1", outcome: "yes" },
            dbAmount: "100",
            onChainAmount: null,
            difference: null,
            status: "missing_on_chain",
          },
        ],
      }),
    );

    const res = await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("partial");
    expect(res.body.data.onChainSnapshot.available).toBe(false);
    expect(res.body.data.onChainSnapshot.unavailableReason).toBe(
      "adapter not configured",
    );
  });

  it("echoes the x-request-id from the request header", async () => {
    mockReconcileMarket.mockResolvedValue(makeResult());

    const res = await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      )
      .set("X-Request-Id", "my-custom-id");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("my-custom-id");
    expect(res.body.data.correlationId).toBe("recon-123"); // value from mock
  });

  it("passes the adminAddress from the JWT sub claim to the service", async () => {
    mockReconcileMarket.mockResolvedValue(makeResult());

    await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      );

    expect(mockReconcileMarket).toHaveBeenCalledWith(
      expect.objectContaining({ adminAddress: ADMIN_ADDRESS }),
    );
  });

  // ── Input validation ───────────────────────────────────────────────────────

  it("returns 400 for a whitespace-only market id", async () => {
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

  // ── Error propagation ──────────────────────────────────────────────────────

  it("surfaces service not_found as 404 via the standardized envelope", async () => {
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

  it("propagates unexpected service errors as 500", async () => {
    mockReconcileMarket.mockRejectedValue(new Error("unexpected db failure"));

    const res = await request(makeApp())
      .get("/api/admin/recon/markets/market-1")
      .set(
        "Authorization",
        `Bearer ${signJwt({ sub: ADMIN_ADDRESS, role: "admin" })}`,
      );

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBeDefined();
  });

  it("does not call reconcileMarket when auth fails", async () => {
    await request(makeApp()).get("/api/admin/recon/markets/market-1");
    expect(mockReconcileMarket).not.toHaveBeenCalled();
  });
});
