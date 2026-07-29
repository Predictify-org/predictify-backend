/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "quota-test-secret-at-least-32-bytes-long!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

const authLimit = jest.fn();
const authWhere = jest.fn(() => ({ limit: authLimit }));
const authFrom = jest.fn(() => ({ where: authWhere }));
const authSelect = jest.fn(() => ({ from: authFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: authSelect })),
}));

jest.mock("../src/db/client", () => ({
  db: { select: jest.fn(), insert: jest.fn(), update: jest.fn(), delete: jest.fn() },
  pool: { on: jest.fn(), end: jest.fn() },
}));

jest.mock("../src/services/quotaRequestService", () => {
  const actual = jest.requireActual("../src/services/quotaRequestService");
  return {
    __esModule: true,
    ...actual,
    createQuotaRequest: jest.fn(),
    getQuotaRequestsByUser: jest.fn(),
    getPendingCountByUser: jest.fn(),
  };
});

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { quotaRequestsRouter } from "../src/routes/quota/requests";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  createQuotaRequest,
  getQuotaRequestsByUser,
  getPendingCountByUser,
} from "../src/services/quotaRequestService";

const mockCreateQuotaRequest = createQuotaRequest as jest.MockedFunction<
  typeof createQuotaRequest
>;
const mockGetQuotaRequestsByUser = getQuotaRequestsByUser as jest.MockedFunction<
  typeof getQuotaRequestsByUser
>;
const mockGetPendingCountByUser = getPendingCountByUser as jest.MockedFunction<
  typeof getPendingCountByUser
>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/quota/requests", quotaRequestsRouter);
  app.use(errorHandler);
  return app;
}

const TEST_SECRET = process.env.JWT_SECRET!;
const TEST_ISSUER = process.env.JWT_ISSUER!;
const TEST_AUDIENCE = process.env.JWT_AUDIENCE!;
const TEST_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_STELLAR = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";
const TEST_UUID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function signToken(sub: string = TEST_STELLAR, options: jwt.SignOptions = {}): string {
  return jwt.sign({ sub }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
    ...options,
  });
}

function mockDbReturnsUser(): void {
  authLimit.mockResolvedValueOnce([
    { id: TEST_USER_ID, stellarAddress: TEST_STELLAR },
  ]);
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    quotaType: "prediction_limit",
    requestedValue: 100,
    reason: "I need to make more predictions for testing.",
    ...overrides,
  };
}

function mockQuotaRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_UUID,
    userId: TEST_USER_ID,
    quotaType: "prediction_limit",
    requestedValue: 100,
    reason: "I need to make more predictions for testing.",
    status: "pending",
    reviewedBy: null,
    reviewNotes: null,
    reviewedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("POST /api/quota/requests", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authSelect.mockImplementation(() => ({ from: authFrom } as any));
    authFrom.mockImplementation(() => ({ where: authWhere } as any));
    authWhere.mockImplementation(() => ({ limit: authLimit } as any));
  });

  it("returns 403 when no Authorization header is present", async () => {
    const res = await request(app)
      .post("/api/quota/requests")
      .send(validPayload());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 for an expired token", async () => {
    const expired = signToken(TEST_STELLAR, { expiresIn: -1 });
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${expired}`)
      .send(validPayload());
    expect(res.status).toBe(403);
  });

  it("returns 403 when the user does not exist", async () => {
    authLimit.mockResolvedValueOnce([]);
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload());
    expect(res.status).toBe(403);
  });

  it("returns 422 for missing required fields", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 422 for invalid quotaType", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload({ quotaType: "invalid_type" }));
    expect(res.status).toBe(422);
  });

  it("returns 422 for requestedValue less than 1", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload({ requestedValue: 0 }));
    expect(res.status).toBe(422);
  });

  it("returns 422 for reason shorter than 10 characters", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload({ reason: "short" }));
    expect(res.status).toBe(422);
  });

  it("returns 422 for reason longer than 1000 characters", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload({ reason: "x".repeat(1001) }));
    expect(res.status).toBe(422);
  });

  it("returns 400 when user has too many pending requests", async () => {
    mockDbReturnsUser();
    mockGetPendingCountByUser.mockResolvedValueOnce(5);

    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload());
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("BadRequest");
  });

  it("returns 422 when service returns validation error", async () => {
    mockDbReturnsUser();
    mockGetPendingCountByUser.mockResolvedValueOnce(0);
    mockCreateQuotaRequest.mockResolvedValueOnce({
      ok: false as const,
      error: {
        kind: "ValidationError",
        message: "Invalid quota type",
        fields: { quotaType: ["Invalid value"] },
      },
    });

    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload());
    expect(res.status).toBe(422);
  });

  it("returns 201 with the created quota request on success", async () => {
    mockDbReturnsUser();
    mockGetPendingCountByUser.mockResolvedValueOnce(0);
    const expected = mockQuotaRequestRow();
    mockCreateQuotaRequest.mockResolvedValueOnce({
      ok: true as const,
      value: expected,
    });

    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload());

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: expected });
  });

  it("calls createQuotaRequest with the authenticated user's UUID", async () => {
    mockDbReturnsUser();
    mockGetPendingCountByUser.mockResolvedValueOnce(0);
    mockCreateQuotaRequest.mockResolvedValueOnce({
      ok: true as const,
      value: mockQuotaRequestRow(),
    });

    await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload());

    expect(mockCreateQuotaRequest).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID }),
    );
  });

  it("returns 500 when service throws unexpectedly", async () => {
    mockDbReturnsUser();
    mockGetPendingCountByUser.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .post("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`)
      .send(validPayload());
    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe("internal_error");
  });
});

describe("GET /api/quota/requests", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authSelect.mockImplementation(() => ({ from: authFrom } as any));
    authFrom.mockImplementation(() => ({ where: authWhere } as any));
    authWhere.mockImplementation(() => ({ limit: authLimit } as any));
  });

  it("returns 403 when no Authorization header is present", async () => {
    const res = await request(app).get("/api/quota/requests");
    expect(res.status).toBe(403);
  });

  it("returns 200 with empty array when user has no requests", async () => {
    mockDbReturnsUser();
    mockGetQuotaRequestsByUser.mockResolvedValueOnce({
      ok: true as const,
      value: [],
    });

    const res = await request(app)
      .get("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("returns 200 with list of quota requests", async () => {
    mockDbReturnsUser();
    const requests = [
      mockQuotaRequestRow({ id: "r1", quotaType: "prediction_limit" }),
      mockQuotaRequestRow({ id: "r2", quotaType: "daily_prediction_limit" }),
    ];
    mockGetQuotaRequestsByUser.mockResolvedValueOnce({
      ok: true as const,
      value: requests,
    });

    const res = await request(app)
      .get("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: requests });
  });

  it("calls getQuotaRequestsByUser with the authenticated user's UUID", async () => {
    mockDbReturnsUser();
    mockGetQuotaRequestsByUser.mockResolvedValueOnce({
      ok: true as const,
      value: [],
    });

    await request(app)
      .get("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(mockGetQuotaRequestsByUser).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("returns 422 when service returns validation error", async () => {
    mockDbReturnsUser();
    mockGetQuotaRequestsByUser.mockResolvedValueOnce({
      ok: false as const,
      error: {
        kind: "ValidationError" as const,
        message: "Some error",
        fields: {},
      },
    });

    const res = await request(app)
      .get("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(res.status).toBe(422);
  });

  it("returns 500 when service throws unexpectedly", async () => {
    mockDbReturnsUser();
    mockGetQuotaRequestsByUser.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/quota/requests")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(res.status).toBe(500);
  });
});
