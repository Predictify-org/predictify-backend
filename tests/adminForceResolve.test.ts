import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/middleware/errorHandler";

const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockWhere = jest.fn();
const mockLimit = jest.fn();
const mockUpdate = jest.fn();
const mockSet = jest.fn();
const mockInsert = jest.fn();
const mockValues = jest.fn();
const mockTransaction = jest.fn();

const mockDb = {
  select: mockSelect,
  transaction: mockTransaction,
};

jest.mock("../src/db", () => ({
  db: mockDb,
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  },
}));

jest.mock("../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "test-correlation-id"),
}));

import { markets } from "../src/db/schema";
import { forceResolveRouter } from "../src/routes/admin/force-resolve";

const SECRET = process.env.JWT_SECRET ?? "test-secret-with-at-least-32-characters";
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";

const ADMIN_ADDR = "GADMIN111111111111111111111111111111111111111111111111111111";
const USER_ADDR  = "GUSER2222222222222222222222222222222222222222222222222222222";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

const adminToken = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userToken  = signJwt({ sub: USER_ADDR, role: "user" });

const MOUNT = "/api/admin/force-resolve";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(MOUNT, forceResolveRouter);
  app.use(errorHandler);
  return app;
}

interface MockMarket {
  id: string;
  status: string;
  resolutionOutcome: string | null;
  resolutionTime: Date;
  winningOutcome: string | null;
  forceFinalized: boolean;
  version: number;
  [key: string]: unknown;
}

function setupDbMock(market: MockMarket | null): void {
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue(market ? [market] : []);

  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({
      update: mockUpdate,
      insert: mockInsert,
    });
  });

  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockResolvedValue([]);
}

function pastDate(): Date {
  return new Date(Date.now() - 86_400_000);
}

function futureDate(): Date {
  return new Date(Date.now() + 86_400_000);
}

function validMarket(overrides: Partial<MockMarket> = {}): MockMarket {
  return {
    id: "mkt-1",
    status: "open",
    resolutionOutcome: null,
    resolutionTime: pastDate(),
    winningOutcome: null,
    forceFinalized: false,
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Auth guards", () => {
  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 for a non-admin JWT", async () => {
    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 for a JWT signed with wrong secret", async () => {
    const badToken = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      "wrong-secret-at-least-32-chars-long!!",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${badToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(403);
  });
});

describe("Input validation", () => {
  it("returns 422 when winningOutcome is missing", async () => {
    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 422 when winningOutcome is empty string", async () => {
    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "" });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });
});

describe("Market eligibility", () => {
  it("returns 404 when market is not found", async () => {
    setupDbMock(null);

    const res = await request(makeApp())
      .post(`${MOUNT}/unknown`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("NotFound");
    expect(res.body.error.message).toBe("Market not found");
  });

  it("returns 409 when market is already forceFinalized", async () => {
    setupDbMock(validMarket({ forceFinalized: true, status: "resolved" }));

    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe("Conflict");
    expect(res.body.error.message).toBe("Market already resolved");
  });

  it("returns 409 when market status is already resolved", async () => {
    setupDbMock(validMarket({ status: "resolved", winningOutcome: "yes" }));

    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe("Conflict");
  });

  it("returns 422 when resolution deadline not yet reached", async () => {
    setupDbMock(validMarket({ resolutionTime: futureDate() }));

    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
    expect(res.body.error.message).toBe(
      "Market has not yet reached its resolution deadline",
    );
  });
});

describe("Successful force-resolve", () => {
  it("returns 200 and resolves the market", async () => {
    setupDbMock(validMarket());

    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      marketId: "mkt-1",
      winningOutcome: "yes",
      forceResolved: true,
    });
  });

  it("performs atomic transaction with update and audit log", async () => {
    setupDbMock(validMarket());

    await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "no" });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(markets);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "resolved",
        winningOutcome: "no",
        forceFinalized: true,
        version: 2,
      }),
    );
    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: "mkt-1",
        adminAddress: ADMIN_ADDR,
        action: "force_resolve",
      }),
    );
  });

  it("handles different winning outcomes", async () => {
    setupDbMock(validMarket());

    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ winningOutcome: "Outcome B" });

    expect(res.status).toBe(200);
    expect(res.body.data.winningOutcome).toBe("Outcome B");
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ winningOutcome: "Outcome B" }),
    );
  });

  it("includes correlationId in the error envelope on failure", async () => {
    setupDbMock(validMarket());
    mockTransaction.mockRejectedValueOnce(new Error("DB failure"));

    const res = await request(makeApp())
      .post(`${MOUNT}/mkt-1`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Correlation-Id", "test-corr-123")
      .send({ winningOutcome: "yes" });

    expect(res.status).toBe(500);
    expect(res.body.error.correlationId).toBe("test-corr-123");
  });
});


