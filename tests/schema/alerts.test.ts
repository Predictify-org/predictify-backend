/**
 * alerts.test.ts
 *
 * Schema stability test for GET /api/alerts.
 *
 * Strategy
 * ────────
 * Mounts the alerts router on a minimal Express app with a mocked
 * `requireAuth` middleware so tests are isolated from the real JWT
 * validation and database look-up. Uses Jest snapshot testing to assert
 * the response shape doesn't drift accidentally when the implementation
 * changes.
 *
 * Coverage
 * ────────
 * • 200 — response shape with alerts array and unreadCount
 * • Empty list is the default when no alerts exist
 */

// ── Env stubs (must precede all src/ imports) ─────────────────────────────────

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";
process.env.REDIS_URL = "redis://localhost:6379";

// ── Mock requireAuth — bypass real JWT validation ────────────────────────────

jest.mock("../../src/middleware/requireAuth", () => ({
  requireAuth: jest.fn((_req: any, _res: any, next: any) => {
    next();
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import { alertsRouter } from "../../src/routes/alerts";

// Basic express app setup to mount the router for snapshot testing
const app = express();
app.use(express.json());

// Inject a test user into every request so route handlers can access req.user
app.use((req, _res, next) => {
  (req as any).user = { id: "test-user-id" };
  next();
});

app.use("/api/alerts", alertsRouter);

describe("Alerts API Schema Stability", () => {
  it("should maintain a stable response shape for GET /api/alerts", async () => {
    const response = await request(app).get("/api/alerts");

    // Assert success
    expect(response.status).toBe(200);

    // Snapshot the response body structure so if the envelope changes,
    // the test fails and forces a conscious decision about the change.
    expect(response.body).toMatchSnapshot();
  });

  it("should return the expected top-level fields", async () => {
    const response = await request(app).get("/api/alerts");

    expect(response.body).toHaveProperty("alerts");
    expect(response.body).toHaveProperty("unreadCount");
    expect(Array.isArray(response.body.alerts)).toBe(true);
    expect(typeof response.body.unreadCount).toBe("number");
  });

  it("should return an empty alerts list by default", async () => {
    const response = await request(app).get("/api/alerts");

    expect(response.body.alerts).toHaveLength(0);
    expect(response.body.unreadCount).toBe(0);
  });

  it("should respond with 200 even when x-correlation-id header is present", async () => {
    const response = await request(app)
      .get("/api/alerts")
      .set("x-correlation-id", "test-trace-id-456");

    expect(response.status).toBe(200);
    expect(response.body).toMatchSnapshot();
  });
});
