/**
 * leaderboard.test.ts
 *
 * Schema stability test for GET /api/leaderboard.
 *
 * Strategy
 * ────────
 * Mounts the leaderboard router on a minimal Express app. Uses Jest snapshot
 * testing to assert the response shape doesn't drift accidentally when the
 * implementation changes.
 */

// ── Env stubs (must precede all src/ imports) ─────────────────────────────────

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL = "redis://localhost:6379";

// ── Mock rateLimitAnon — bypass rate limiting in tests ───────────────────────

jest.mock("../../src/middleware/rateLimitAnon", () => ({
  rateLimitAnon: jest.fn((_req: any, _res: any, next: any) => {
    next();
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import { leaderboardRouter } from "../../src/routes/leaderboard";
import { db } from "../../src/db/db";

// Basic express app setup to mount the router for snapshot testing
const app = express();
app.use(express.json());

app.use("/api/leaderboard", leaderboardRouter);

describe("Leaderboard API Schema Stability", () => {
  afterAll(async () => {
    // Close DB connection to prevent Jest from hanging
    // We import db from src/db/db above, assuming it exposes a way to close or we don't strictly need it if tests close normally, but good practice.
    // wait, I don't know the exact db export. Let me check if alerts.test.ts closed it.
    // Actually alerts.test.ts didn't close it. I will remove this block for now.
  });

  it("should maintain a stable response shape for GET /api/leaderboard", async () => {
    const response = await request(app).get("/api/leaderboard");

    // Assert success
    expect(response.status).toBe(200);

    // Snapshot the response body structure so if the envelope changes,
    // the test fails and forces a conscious decision about the change.
    expect(response.body).toMatchSnapshot();
  });

  it("should return the expected top-level fields", async () => {
    const response = await request(app).get("/api/leaderboard");

    expect(response.body).toHaveProperty("data");
    expect(response.body).toHaveProperty("meta");
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(typeof response.body.meta.limit).toBe("number");
    expect(typeof response.body.meta.offset).toBe("number");
    expect(typeof response.body.meta.count).toBe("number");
    expect(response.body.meta.period).toBe("all_time"); // Default period
  });

  it("should respond with 400 for invalid query parameters", async () => {
    const response = await request(app)
      .get("/api/leaderboard")
      .query({ limit: -1 });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error.code).toBe("validation_error");
    expect(response.body).toMatchSnapshot();
  });
  
  it("should respond with 200 even when x-correlation-id header is present", async () => {
    const response = await request(app)
      .get("/api/leaderboard")
      .set("x-correlation-id", "test-trace-id-456");

    expect(response.status).toBe(200);
    expect(response.body).toMatchSnapshot();
  });
});
