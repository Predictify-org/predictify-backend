process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "a-very-long-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
queryBuilder.offset = jest.fn().mockImplementation((val) => mockOffset(val));

const mockSelect = jest.fn().mockReturnValue(queryBuilder);

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
};

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => mockDb),
}));

import request from "supertest";
import jwt from "jsonwebtoken";
import express from "express";
import { createExportsRouter } from "../src/routes/exports";
import { errorHandler } from "../src/middleware/errorHandler";

const TEST_SECRET = "a-very-long-test-secret-at-least-32-bytes!!";
const TEST_ISSUER = "predictify";
const TEST_AUDIENCE = "predictify-app";
const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_STELLAR = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";

function signToken(_userId = TEST_USER_ID, stellarAddress = TEST_STELLAR): string {
  return jwt.sign({ sub: stellarAddress }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
  });
}

describe("Rate limiting on /api/exports", () => {
  const RATE_LIMIT_CAPACITY = 2;

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/exports",
      createExportsRouter({ rateLimit: { capacity: RATE_LIMIT_CAPACITY, refillWindowMs: 60000 } }),
    );
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockLimit.mockReset();
    mockOffset.mockReset();
  });

  it("allows requests up to the token bucket capacity", async () => {
    mockLimit.mockResolvedValue([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockOffset.mockResolvedValue([]);
    const app = makeApp();

    for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
      const res = await request(app)
        .get("/api/exports/predictions?format=json")
        .set("Authorization", `Bearer ${signToken()}`);

      expect(res.status).toBe(200);
      expect(Number(res.headers["ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns 429 with Retry-After when token bucket is exhausted", async () => {
    mockLimit.mockResolvedValue([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockOffset.mockResolvedValue([]);
    const app = makeApp();

    for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
      await request(app)
        .get("/api/exports/predictions?format=json")
        .set("Authorization", `Bearer ${signToken()}`);
    }

    const res = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limit_exceeded");
    expect(res.body.error.message).toBe("Too many requests");
    expect(res.body.error.retryAfter).toBeDefined();
    expect(typeof res.body.error.retryAfter).toBe("number");
    expect(res.body.error.retryAfter).toBeGreaterThan(0);
    expect(res.body.error.resetAt).toBeDefined();
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit-remaining"]).toBe("0");
  });

  it("returns 429 with proper error envelope", async () => {
    mockLimit.mockResolvedValue([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockOffset.mockResolvedValue([]);
    const app = makeApp();

    for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
      await request(app)
        .get("/api/exports/predictions?format=json")
        .set("Authorization", `Bearer ${signToken()}`);
    }

    const res = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests",
      },
    });
    expect(typeof res.body.error.retryAfter).toBe("number");
    expect(typeof res.body.error.resetAt).toBe("string");
  });

  it("allows requests from a different user after first user is rate limited", async () => {
    mockLimit.mockResolvedValue([{ id: TEST_USER_ID, stellarAddress: TEST_STELLAR }]);
    mockOffset.mockResolvedValue([]);
    const app = makeApp();

    for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
      await request(app)
        .get("/api/exports/predictions?format=json")
        .set("Authorization", `Bearer ${signToken()}`);
    }

    const firstUserRes = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken()}`);
    expect(firstUserRes.status).toBe(429);

    const secondStellar = "GDEF9876543210ABCDEF9876543210ABCDEF9876543210ABCDEF98";
    const secondUserId = "22222222-2222-2222-2222-222222222222";

    mockLimit.mockResolvedValue([{ id: secondUserId, stellarAddress: secondStellar }]);

    const secondUserRes = await request(app)
      .get("/api/exports/predictions?format=json")
      .set("Authorization", `Bearer ${signToken(secondUserId, secondStellar)}`);

    expect(secondUserRes.status).toBe(200);
    expect(Number(secondUserRes.headers["ratelimit-remaining"])).toBe(RATE_LIMIT_CAPACITY - 1);
  });
});
