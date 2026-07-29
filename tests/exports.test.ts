// ---------------------------------------------------------------------------
// 1. Set environment variables BEFORE importing index/app modules
// ---------------------------------------------------------------------------
const TEST_SECRET = "a-very-long-test-secret-at-least-32-bytes!!";
const TEST_ISSUER = "predictify";
const TEST_AUDIENCE = "predictify-app";
const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_STELLAR = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = TEST_SECRET;
process.env.JWT_ISSUER = TEST_ISSUER;
process.env.JWT_AUDIENCE = TEST_AUDIENCE;

// ---------------------------------------------------------------------------
// 2. Mock database dependencies
// ---------------------------------------------------------------------------
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
  }));
  return { Pool };
});

const mockValues = jest.fn().mockResolvedValue(undefined);
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockLimit = jest.fn();
const mockOffset = jest.fn();

const queryBuilder: any = {};
queryBuilder.from = jest.fn().mockReturnValue(queryBuilder);
queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
queryBuilder.orderBy = jest.fn().mockReturnValue(queryBuilder);
queryBuilder.limit = jest.fn().mockImplementation((val) => {
  if (val === 1) {
    return mockLimit();
  }
  return queryBuilder;
});
queryBuilder.offset = jest.fn().mockImplementation((val) => {
  return mockOffset(val);
});

const mockSelect = jest.fn().mockReturnValue(queryBuilder);

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
};

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => mockDb),
}));

// ---------------------------------------------------------------------------
// 3. Now import application modules
// ---------------------------------------------------------------------------
import request from "supertest";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createApp } from "../src/index";

const app = createApp();

function signToken(_userId = TEST_USER_ID, stellarAddress = TEST_STELLAR): string {
  return jwt.sign({ sub: stellarAddress }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
  });
}

const predictionsMockData = [
  {
    id: "pred-1",
    marketId: "mkt-1",
    userId: TEST_USER_ID,
    outcome: "yes",
    amount: "1000",
    txHash: "0xhash1",
    status: "confirmed",
    result: "won",
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
  },
  {
    id: "pred-2",
    marketId: "mkt-2",
    userId: TEST_USER_ID,
    outcome: "no",
    amount: "500",
    txHash: "0xhash2",
    status: "pending",
    result: null,
    createdAt: new Date("2026-06-15T12:00:00.000Z"),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  // Default mock behavior
  mockLimit.mockReset();
  mockOffset.mockReset();

  // requireAuth user query (1st limit(1))
  mockLimit.mockResolvedValueOnce([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
  // Idempotency lookup (2nd limit(1)) -> miss by default
  mockLimit.mockResolvedValueOnce([]);

  // Default empty predictions
  mockOffset.mockResolvedValue([]);
});

describe("GET /api/exports/predictions", () => {
  it("unauthorized request returns 401", async () => {
    const res = await request(app).get("/api/exports/predictions?format=csv");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("exports prediction history in CSV format", async () => {
    mockOffset.mockResolvedValueOnce(predictionsMockData);

    const res = await request(app)
      .get("/api/exports/predictions?format=csv")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment; filename=");
    
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe("id,marketId,userId,outcome,amount,txHash,status,result,createdAt");
    expect(lines[1]).toContain("pred-1,mkt-1");
    expect(lines[1]).toContain("yes,1000,0xhash1,confirmed,won");
    expect(lines[2]).toContain("pred-2,mkt-2");
    expect(lines[2]).toContain("no,500,0xhash2,pending,,2026-06-15T12:00:00.000Z");
  });

  it("exports prediction history in JSON format", async () => {
    mockOffset.mockResolvedValueOnce(predictionsMockData);

    const res = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain("attachment; filename=");

    const data = JSON.parse(res.text);
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe("pred-1");
    expect(data[0].outcome).toBe("yes");
    expect(data[1].id).toBe("pred-2");
    expect(data[1].result).toBeNull();
  });

  it("filters predictions by valid date range", async () => {
    mockOffset.mockResolvedValueOnce([predictionsMockData[1]]);

    const res = await request(app)
      .get("/api/exports/predictions?format=json&startDate=2026-06-10T00:00:00.000Z&endDate=2026-06-20T00:00:00.000Z")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    const data = JSON.parse(res.text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("pred-2");
  });

  it("returns 400 validation error for invalid format", async () => {
    const res = await request(app)
      .get("/api/exports/predictions?format=xml")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 validation error when startDate is after endDate", async () => {
    const res = await request(app)
      .get("/api/exports/predictions?format=json&startDate=2026-06-20T00:00:00.000Z&endDate=2026-06-10T00:00:00.000Z")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns empty csv export when no results", async () => {
    mockOffset.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/exports/predictions?format=csv")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("id,marketId,userId,outcome,amount,txHash,status,result,createdAt");
  });

  it("returns 400 for invalid idempotency key header format", async () => {
    const res = await request(app)
      .get("/api/exports/predictions?format=csv")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", "invalid-key-because-of-unicode-字符");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_idempotency_key");
  });

  it("replays cached response for matching idempotency key", async () => {
    const key = "idemp-key-123";
    const fingerprintData = JSON.stringify({
      userId: TEST_USER_ID,
      format: "json",
      startDate: undefined,
      endDate: undefined,
    });
    const fingerprint = crypto.createHash("sha256").update(fingerprintData).digest("hex");

    // Reset default mock
    mockLimit.mockReset();
    // 1st call user lookup
    mockLimit.mockResolvedValueOnce([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    // 2nd call idempotency lookup returns hit
    mockLimit.mockResolvedValueOnce([
      {
        key,
        fingerprint,
        responseStatus: 200,
        responseBody: { content: '[{"id":"pred-cached"}]' },
        responseHeaders: { "content-type": "application/json" },
        expiresAt: new Date(Date.now() + 10000),
      },
    ]);

    const res = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", key);

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    const data = JSON.parse(res.text);
    expect(data[0].id).toBe("pred-cached");
  });

  it("returns 409 conflict for idempotency key with different parameters", async () => {
    const key = "idemp-key-123";

    mockLimit.mockReset();
    mockLimit.mockResolvedValueOnce([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockLimit.mockResolvedValueOnce([
      {
        key,
        fingerprint: "different-fingerprint-hash",
        responseStatus: 200,
        responseBody: { content: "[]" },
        responseHeaders: { "content-type": "application/json" },
        expiresAt: new Date(Date.now() + 10000),
      },
    ]);

    const res = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", key);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("idempotency_conflict");
  });

  it("handles large dataset exports by streaming batch-by-batch", async () => {
    // Generate large list of mock predictions (say 600 items)
    const largeMockBatch1: any[] = [];
    for (let i = 0; i < 500; i++) {
      largeMockBatch1.push({
        id: `pred-batch1-${i}`,
        marketId: "mkt-1",
        userId: TEST_USER_ID,
        outcome: "yes",
        amount: "100",
        txHash: "0xhash",
        status: "confirmed",
        result: null,
        createdAt: new Date(),
      });
    }

    const largeMockBatch2: any[] = [];
    for (let i = 0; i < 100; i++) {
      largeMockBatch2.push({
        id: `pred-batch2-${i}`,
        marketId: "mkt-1",
        userId: TEST_USER_ID,
        outcome: "yes",
        amount: "100",
        txHash: "0xhash",
        status: "confirmed",
        result: null,
        createdAt: new Date(),
      });
    }

    mockOffset.mockResolvedValueOnce(largeMockBatch1);
    mockOffset.mockResolvedValueOnce(largeMockBatch2);

    const res = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    const data = JSON.parse(res.text);
    expect(data).toHaveLength(600);
    expect(data[0].id).toBe("pred-batch1-0");
    expect(data[500].id).toBe("pred-batch2-0");
    
    // Check that we fetched twice via offset (first at 0, second at 500)
    expect(mockOffset).toHaveBeenCalledTimes(2);
    expect(mockOffset.mock.calls[0][0]).toBe(0);
    expect(mockOffset.mock.calls[1][0]).toBe(500);
  });
});

describe("POST and PATCH /api/exports mutations with Idempotency-Key", () => {
  it("POST /api/exports/predictions with Idempotency-Key replays response on match", async () => {
    const key = "post-idemp-key-999";
    const body = { format: "json" };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");

    mockLimit.mockReset();
    // requireAuth user lookup
    mockLimit.mockResolvedValueOnce([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    // Idempotency lookup hit
    mockLimit.mockResolvedValueOnce([
      {
        key,
        fingerprint,
        responseStatus: 200,
        responseBody: [{ id: "pred-post-cached" }],
        responseHeaders: { "content-type": "application/json" },
        expiresAt: new Date(Date.now() + 10000),
      },
    ]);

    const res = await request(app)
      .post("/api/exports/predictions")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body[0].id).toBe("pred-post-cached");
  });

  it("POST /api/exports/predictions returns 409 conflict when request body changes", async () => {
    const key = "post-idemp-key-999";
    const body = { format: "csv" };

    mockLimit.mockReset();
    mockLimit.mockResolvedValueOnce([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockLimit.mockResolvedValueOnce([
      {
        key,
        fingerprint: "old-different-fingerprint",
        responseStatus: 200,
        responseBody: [],
        responseHeaders: {},
        expiresAt: new Date(Date.now() + 10000),
      },
    ]);

    const res = await request(app)
      .post("/api/exports/predictions")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("idempotency_conflict");
    expect(res.body.error.message).toBe("Idempotency key conflict");
    expect(res.body.error.correlationId).toBeDefined();
  });

  it("PATCH /api/exports/predictions with Idempotency-Key replays response on match", async () => {
    const key = "patch-idemp-key-777";
    const body = { format: "csv" };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");

    mockLimit.mockReset();
    mockLimit.mockResolvedValueOnce([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockLimit.mockResolvedValueOnce([
      {
        key,
        fingerprint,
        responseStatus: 200,
        responseBody: "id,marketId\npred-1,mkt-1",
        responseHeaders: { "content-type": "text/csv" },
        expiresAt: new Date(Date.now() + 10000),
      },
    ]);

    const res = await request(app)
      .patch("/api/exports/predictions")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.text).toContain("pred-1,mkt-1");
  });

  it("POST /api/exports returns 400 for invalid idempotency key format with error envelope", async () => {
    const res = await request(app)
      .post("/api/exports")
      .set("Authorization", `Bearer ${signToken()}`)
      .set("Idempotency-Key", "invalid-key-with-invalid-chars-\u0000")
      .send({ format: "json" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_idempotency_key");
    expect(res.body.error.message).toBe("Invalid idempotency key format");
    expect(res.body.error.correlationId).toBeDefined();
  });
});

