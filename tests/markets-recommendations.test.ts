// ---------------------------------------------------------------------------
// 1. Env vars (must run BEFORE project imports)
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3002";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "recommendations-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";

// ---------------------------------------------------------------------------
// 2. Mock `pg` so requireAuth cannot open a real socket.
// ---------------------------------------------------------------------------
jest.mock("pg", () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  }));
  return { Pool };
});

// ---------------------------------------------------------------------------
// 3. Mock drizzle-orm/node-postgres so the user lookup chain is controllable.
// ---------------------------------------------------------------------------
const authLimit = jest.fn();
const authWhere = jest.fn(() => ({ limit: authLimit }));
const authFrom = jest.fn(() => ({ where: authWhere }));
const authSelect = jest.fn(() => ({ from: authFrom }));

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({ select: authSelect })),
}));

// ---------------------------------------------------------------------------
// 4. Mock the marketService
// ---------------------------------------------------------------------------
jest.mock("../src/services/marketService", () => {
  const actual = jest.requireActual("../src/services/marketService");
  return {
    __esModule: true,
    ...actual,
    getRecommendedMarkets: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// 5. Project imports
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { marketsRouter } from "../src/routes/markets/index";
import { errorHandler } from "../src/middleware/errorHandler";
import { getRecommendedMarkets } from "../src/services/marketService";

const mockGetRecommendedMarkets = getRecommendedMarkets as jest.MockedFunction<typeof getRecommendedMarkets>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Inject a default Origin header so the CORS allowlist middleware
  // applied inside marketsRouter passes in tests.
  app.use((req, _res, next) => {
    if (!req.headers["origin"]) {
      req.headers["origin"] = "http://localhost:5173";
    }
    next();
  });
  app.use("/api/markets", marketsRouter);
  app.use(errorHandler);
  return app;
}

const TEST_SECRET = process.env.JWT_SECRET!;
const TEST_ISSUER = process.env.JWT_ISSUER!;
const TEST_AUDIENCE = process.env.JWT_AUDIENCE!;
const TEST_USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TEST_STELLAR = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12";

function signToken(sub: string = TEST_STELLAR): string {
  return jwt.sign({ sub }, TEST_SECRET, {
    algorithm: "HS256",
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresIn: 3600,
  });
}

function mockDbReturnsUser(): void {
  authLimit.mockResolvedValueOnce([
    { id: TEST_USER_ID, stellarAddress: TEST_STELLAR },
  ]);
}

describe("GET /api/markets/recommendations & /api/recommendations", () => {
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

  it("returns 401 when Authorization header is absent", async () => {
    const res = await request(app).get("/api/markets/recommendations");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("returns 200 with recommendations and nextCursor for authenticated user", async () => {
    mockDbReturnsUser();
    const mockRecs = [
      { id: "m-1", question: "Market 1", status: "active", resolutionTime: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    mockGetRecommendedMarkets.mockResolvedValueOnce({
      data: mockRecs,
      nextCursor: "v1|24|2026-01-01T00:00:00.000Zm-1",
    });

    const res = await request(app)
      .get("/api/markets/recommendations")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockRecs);
    expect(res.body.nextCursor).toBe("v1|24|2026-01-01T00:00:00.000Zm-1");
    expect(mockGetRecommendedMarkets).toHaveBeenCalledWith(TEST_USER_ID, {
      limit: 20,
      cursor: undefined,
    });
  });

  it("passes limit and cursor query params to getRecommendedMarkets", async () => {
    mockDbReturnsUser();
    const mockRecs = [
      { id: "m-2", question: "Market 2", status: "active", resolutionTime: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const cursor = "v1|24|2026-01-01T00:00:00.000Zm-1";
    mockGetRecommendedMarkets.mockResolvedValueOnce({
      data: mockRecs,
      nextCursor: null,
    });

    const res = await request(app)
      .get(`/api/markets/recommendations?limit=5&cursor=${encodeURIComponent(cursor)}`)
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockRecs);
    expect(res.body.nextCursor).toBeNull();
    expect(mockGetRecommendedMarkets).toHaveBeenCalledWith(TEST_USER_ID, {
      limit: 5,
      cursor,
    });
  });

  it("returns 400 when invalid query parameters are supplied", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .get("/api/markets/recommendations?limit=invalid")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(400);
  });

  it("returns 400 when unknown query parameters are supplied (.strict())", async () => {
    mockDbReturnsUser();
    const res = await request(app)
      .get("/api/markets/recommendations?foo=bar")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(400);
  });

  it("returns 200 with empty list and null nextCursor when no recommendations found", async () => {
    mockDbReturnsUser();
    mockGetRecommendedMarkets.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });

    const res = await request(app)
      .get("/api/markets/recommendations")
      .set("Authorization", `Bearer ${signToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });
});

