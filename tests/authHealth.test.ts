/**
 * tests/authHealth.test.ts
 *
 * Tests for GET /api/auth/health endpoint.
 */

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL = "redis://localhost:6379";

import request from "supertest";
import express from "express";
import { authHealthRouter } from "../src/routes/auth/health";
import { errorHandler } from "../src/middleware/errorHandler";

// Mock db/client to avoid real DB connections
jest.mock("../src/db/client", () => ({
  pool: {
    query: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  },
  db: {
    select: jest.fn(),
  },
}));

import { pool } from "../src/db/client";

function makeApp(): express.Express {
  const app = express();
  app.use("/api/auth/health", authHealthRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

describe("GET /api/auth/health", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 when database is ok", async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/api/auth/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.dependencies.database.status).toBe("ok");
    expect(res.body.dependencies.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 when database is down", async () => {
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/api/auth/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.dependencies.database.status).toBe("down");
    expect(res.body.dependencies.database.error).toBe("Database unavailable");
  });

  it("includes correlationId from request header", async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const correlationId = "test-correlation-456";
    const res = await request(app)
      .get("/api/auth/health")
      .set("x-correlation-id", correlationId);

    expect(res.body.correlationId).toBe(correlationId);
  });

  it("generates correlationId when not provided", async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/api/auth/health");

    expect(res.body.correlationId).toBeDefined();
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("includes checkedAt timestamp in ISO format", async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/api/auth/health");

    expect(res.body.checkedAt).toBeDefined();
    const date = new Date(res.body.checkedAt);
    expect(date.getTime()).toBeGreaterThan(0);
  });

  it("does not require authentication", async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/api/auth/health");

    expect(res.status).toBe(200);
  });
});
